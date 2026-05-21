-- 오늘의 개발 운세 — GitHub 계정 `created_at` 을 생년월일로 삼아 사주를 결정론적으로 계산하고,
-- 그 변수들을 LLM(OpenAI) 에 전달해 생성한 한국어 텍스트를 저장.
--
-- 디자인 노트:
--   * (device_id, fortune_date) 복합 PK — 같은 날 중복 생성 방지. UPSERT 로 idempotent.
--   * 사주는 평생 안 변하지만 fortune_text 는 매일 새로 생성되므로 행도 매일 하나씩 누적.
--   * `saju_json` 은 SajuChart 직렬화 (디버깅/재해석용). 추후 archive UI 에서 활용 가능.
--   * RLS 활성 + 정책 없음 → anon 직접 접근 불가. 모든 read/write 는 edge function `fortune`
--     (service_role) 경유. HMAC 서명으로 본인 device 만 가능.

CREATE TABLE daily_fortunes (
    device_id     UUID NOT NULL REFERENCES users(device_id) ON DELETE CASCADE,
    fortune_date  DATE NOT NULL,
    saju_json     JSONB NOT NULL,
    fortune_text  TEXT NOT NULL,
    model         TEXT,                                       -- 사용한 LLM 모델명 (예: "gpt-4o-mini")
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_id, fortune_date)
);

-- 본인 archive 조회 (최근순) 용 보조 인덱스. PK 가 이미 (device_id, fortune_date) 라서
-- prefix scan 가능하지만 DESC 정렬을 자주 쓸 거라 명시적으로 둠.
CREATE INDEX daily_fortunes_user_date_desc ON daily_fortunes (device_id, fortune_date DESC);

ALTER TABLE daily_fortunes ENABLE ROW LEVEL SECURITY;
-- 명시적 정책 없음 → anon 모든 작업 거부. edge function 만 서비스 키로 접근.
