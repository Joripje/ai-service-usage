// POST /fortune
// 오늘의 개발 운세 — 단일 호출로 fetch + (캐시 미스 시) OpenAI 호출 + save 모두 처리.
//
// 보안 모델:
//   * OpenAI 키는 `Deno.env.get("OPENAI_API_KEY")` 로 — 앱 바이너리에 절대 노출되지 않음.
//     ad-hoc 서명 데스크톱 앱은 strings/lldb 로 키 추출이 너무 쉬워 클라이언트 보관 불가.
//   * 명리학 사주 계산은 클라이언트가 결정론적으로 수행 (외부 의존 0) → 서버는 그 결과를
//     OpenAI 프롬프트에 전달만 함. 서버에서 사주 재계산하지 않음.
//   * Rate limit 은 (device_id, fortune_date) PK 가 자연 제약 — 같은 날 두 번째 호출은
//     캐시 hit 으로 OpenAI 비호출.
//
// HMAC: payload 전체 canonicalize → device 의 hmac_key_b64 로 verify. submit/post 와 동일.

import { jsonResponse, errorResponse, handleOptions } from "../_shared/cors.ts";
import { getDb } from "../_shared/db.ts";
import { verifyHmac } from "../_shared/hmac.ts";
import { isValidUUID } from "../_shared/validation.ts";

interface FortunePayload {
  date: string;        // "YYYY-MM-DD"
  dailyJson: string;   // DailyFortune JSON (오늘 일진 + 일간 vs 일진 관계)
  deviceId: string;
  sajuJson: string;    // SajuChart JSON (사주팔자 + 오행 분포)
  ts: number;
}

interface FortuneRequest {
  payload: FortunePayload;
  signature: string;
}

const MAX_CLOCK_SKEW_SEC = 3600;
const MAX_SAJU_JSON_LEN = 4000;
const MAX_DAILY_JSON_LEN = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 서버측 모델 고정 — 사용자가 비용 의식할 필요 없게 가장 저렴한 모델로.
const OPENAI_MODEL = "gpt-4o-mini";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed");

  let body: FortuneRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json");
  }
  const p = body.payload;
  if (!p || typeof p !== "object") return errorResponse(400, "missing_payload");
  if (!isValidUUID(p.deviceId)) return errorResponse(400, "invalid_device_id");
  if (typeof p.date !== "string" || !DATE_RE.test(p.date)) return errorResponse(400, "invalid_date");
  if (typeof p.sajuJson !== "string" || p.sajuJson.length === 0 || p.sajuJson.length > MAX_SAJU_JSON_LEN) {
    return errorResponse(400, "invalid_saju_json");
  }
  if (typeof p.dailyJson !== "string" || p.dailyJson.length === 0 || p.dailyJson.length > MAX_DAILY_JSON_LEN) {
    return errorResponse(400, "invalid_daily_json");
  }
  if (typeof p.ts !== "number") return errorResponse(400, "invalid_payload_types");
  if (typeof body.signature !== "string" || body.signature.length !== 64) {
    return errorResponse(400, "invalid_signature");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - p.ts) > MAX_CLOCK_SKEW_SEC) {
    return errorResponse(400, "clock_skew");
  }

  const db = getDb();
  const { data: user, error: userErr } = await db
    .from("users")
    .select("device_id, hmac_key_b64, status")
    .eq("device_id", p.deviceId)
    .single();
  if (userErr || !user) return errorResponse(404, "device_not_registered");
  if (user.status === "banned") return errorResponse(403, "banned");

  const hmacPayload: Record<string, unknown> = {
    date: p.date,
    dailyJson: p.dailyJson,
    deviceId: p.deviceId,
    sajuJson: p.sajuJson,
    ts: p.ts,
  };
  const ok = await verifyHmac(hmacPayload, body.signature, user.hmac_key_b64);
  if (!ok) return errorResponse(401, "bad_signature");

  // 1) 캐시 hit? (device_id, fortune_date) row 가 있으면 그대로 반환.
  const { data: existing, error: selErr } = await db
    .from("daily_fortunes")
    .select("device_id, fortune_date, saju_json, fortune_text, model, created_at")
    .eq("device_id", p.deviceId)
    .eq("fortune_date", p.date)
    .maybeSingle();
  if (selErr) {
    console.error("fortune select failed", selErr);
    return errorResponse(500, "select_failed");
  }
  if (existing) {
    return jsonResponse({
      row: rowResponse(existing, /* cached */ true),
    });
  }

  // 2) sajuJson / dailyJson parse — 프롬프트 구성을 위해.
  let saju: Record<string, unknown>;
  let daily: Record<string, unknown>;
  try {
    saju = JSON.parse(p.sajuJson);
  } catch {
    return errorResponse(400, "saju_json_not_json");
  }
  try {
    daily = JSON.parse(p.dailyJson);
  } catch {
    return errorResponse(400, "daily_json_not_json");
  }

  // 3) OpenAI 호출
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    console.error("OPENAI_API_KEY env missing");
    return errorResponse(503, "openai_not_configured");
  }

  let fortuneText: string;
  try {
    fortuneText = await callOpenAI(saju, daily, OPENAI_MODEL, apiKey);
  } catch (e) {
    console.error("OpenAI call failed", e);
    const msg = e instanceof Error ? e.message : "unknown";
    return errorResponse(502, `openai_error: ${msg.slice(0, 200)}`);
  }

  // 4) row insert. ignoreDuplicates — 같은 날 race condition 시 기존 row 유지.
  const { error: insErr } = await db.from("daily_fortunes").upsert(
    {
      device_id: p.deviceId,
      fortune_date: p.date,
      saju_json: saju,
      fortune_text: fortuneText,
      model: OPENAI_MODEL,
    },
    { onConflict: "device_id,fortune_date", ignoreDuplicates: true },
  );
  if (insErr) {
    // 저장 실패해도 사용자에겐 텍스트 반환 — UX 우선. 같은 비용 다시 들이는 일은 거의 없음 (네트워크 transient).
    console.error("fortune upsert failed (returning text anyway)", insErr);
  }

  return jsonResponse({
    row: {
      deviceId: p.deviceId,
      fortuneDate: p.date,
      sajuJson: p.sajuJson,
      fortuneText,
      model: OPENAI_MODEL,
      createdAt: new Date().toISOString(),
      cached: false,
    },
  });
});

function rowResponse(data: Record<string, unknown>, cached: boolean) {
  return {
    deviceId: data.device_id,
    fortuneDate: data.fortune_date,
    sajuJson:
      typeof data.saju_json === "string"
        ? data.saju_json
        : JSON.stringify(data.saju_json),
    fortuneText: data.fortune_text,
    model: data.model,
    createdAt: data.created_at,
    cached,
  };
}

async function callOpenAI(
  saju: Record<string, unknown>,
  daily: Record<string, unknown>,
  model: string,
  apiKey: string,
): Promise<string> {
  const systemPrompt = "당신은 사주 명리학을 이해하고 그 변수를 개발자 일상으로 재해석하는 점성술사입니다. 한국어로 200-300자, 3-4 문장, 캐주얼한 톤. 코드 리뷰/배포/디버깅/페어 프로그래밍/리팩토링 같은 개발 컨텍스트로 풀어내세요. 예언/단정형(\"반드시 ~한다\", \"~할 것이다\")은 피하고 가벼운 권유형(\"~해보세요\", \"~하기 좋은 날입니다\")으로. 사주 변수를 그대로 나열하지 말고 해석된 결과만 자연스러운 문장으로. 이모지 없이. 주의: 사용자의 출생시는 GitHub 가입 시각을 사용한 근사값이므로 시주는 참고 정도로만 활용하세요.";

  const userPrompt = buildUserPrompt(saju, daily);

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 400,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("empty_response");
  }
  return text.trim();
}

function buildUserPrompt(saju: Record<string, unknown>, daily: Record<string, unknown>): string {
  const year = pillarName(saju.year);
  const month = pillarName(saju.month);
  const day = pillarName(saju.day);
  const hour = pillarName(saju.hour);
  const dayStem = stemName(saju.day);
  const elements = elementsLine(saju.fiveElementCounts);
  const todayPillar = pillarName(daily.today);
  const relation = String(daily.relation ?? "?");
  return [
    "다음은 명리학적으로 계산된 변수입니다. 이를 종합해 오늘의 개발 운세를 작성해주세요.",
    "",
    `- 본인 사주팔자(년/월/일/시주): ${year} · ${month} · ${day} · ${hour}`,
    `- 일간(본인 핵심 오행): ${dayStem}`,
    `- 오행 분포: ${elements}`,
    `- 오늘 일진: ${todayPillar}`,
    `- 일간 vs 오늘 천간 관계: ${relation}`,
  ].join("\n");
}

// Swift SajuPillar Codable 자동 합성 결과: { stem: Int, branch: Int } (raw value).
// 서버에선 다시 한글로 풀어 프롬프트에 박는다.
const STEMS_KO = ["갑","을","병","정","무","기","경","신","임","계"];
const BRANCHES_KO = ["자","축","인","묘","진","사","오","미","신","유","술","해"];

function pillarName(p: unknown): string {
  if (!p || typeof p !== "object") return "?";
  const obj = p as Record<string, unknown>;
  const stemIdx = typeof obj.stem === "number" ? obj.stem : -1;
  const branchIdx = typeof obj.branch === "number" ? obj.branch : -1;
  return `${STEMS_KO[stemIdx] ?? "?"}${BRANCHES_KO[branchIdx] ?? "?"}`;
}

function stemName(p: unknown): string {
  if (!p || typeof p !== "object") return "?";
  const obj = p as Record<string, unknown>;
  const stemIdx = typeof obj.stem === "number" ? obj.stem : -1;
  return STEMS_KO[stemIdx] ?? "?";
}

function elementsLine(counts: unknown): string {
  const order = ["목", "화", "토", "금", "수"];
  if (!counts || typeof counts !== "object") return order.join(" · ");
  const obj = counts as Record<string, unknown>;
  return order.map((k) => {
    const v = obj[k];
    return `${k} ${typeof v === "number" ? v : 0}`;
  }).join(" · ");
}
