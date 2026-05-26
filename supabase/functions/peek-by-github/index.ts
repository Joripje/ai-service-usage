// POST /peek-by-github
// GitHub OAuth 토큰으로 매칭되는 user 메타데이터 조회 — **변경 없음**.
// 클라이언트가 복원 컨펌 다이얼로그("X 시점으로 유저정보 복원합니다") 표시용으로 호출.
// 컨펌 후 실제 hmac_key rotation은 recover-by-github로.
//
// 분리 이유: peek 단계에서 rotation까지 하면 사용자가 컨펌 취소해도 기존 디바이스의
// hmac_key가 이미 무효화됨. peek은 read-only로 두고 사용자 명시 액션에서만 rotate.

import { jsonResponse, errorResponse, handleOptions } from "../_shared/cors.ts";
import { getDb } from "../_shared/db.ts";
import { fetchGitHubUser } from "../_shared/github.ts";

interface PeekRequest {
  githubToken: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed");

  let body: PeekRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json");
  }
  if (typeof body.githubToken !== "string" || body.githubToken.length < 20) {
    return errorResponse(400, "invalid_github_token");
  }

  let gh;
  try {
    gh = await fetchGitHubUser(body.githubToken);
  } catch (e) {
    console.error("github verification failed", e);
    return errorResponse(401, "github_verification_failed");
  }

  const db = getDb();
  const { data: user } = await db
    .from("users")
    .select("nickname, total_coins, status, registered_at, last_submitted_at")
    .eq("github_user_id", gh.id)
    .single();

  if (!user) return errorResponse(404, "no_account_linked_to_github");
  if (user.status === "banned") return errorResponse(403, "banned");

  // last_submitted_at은 마지막 백업(submit) 시점 — 복원되는 상태의 의미상 timestamp.
  // 첫 등록 후 한 번도 submit 안 한 사용자는 null → registered_at fallback.
  return jsonResponse({
    nickname: user.nickname,
    totalCoins: user.total_coins,
    backupAt: user.last_submitted_at ?? user.registered_at,
    githubLogin: gh.login,
  });
});
