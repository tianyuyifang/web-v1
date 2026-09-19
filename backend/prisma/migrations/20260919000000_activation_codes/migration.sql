-- One-time activation (redeem) codes: admin generates, user redeems to renew.
CREATE TABLE "activation_codes" (
    "id"              UUID         NOT NULL,
    "code"            TEXT         NOT NULL,
    "duration_days"   INTEGER      NOT NULL DEFAULT 0,
    "duration_months" INTEGER      NOT NULL DEFAULT 0,
    "tier"            TEXT,
    "label"           TEXT,
    "created_by"      UUID,
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at"         TIMESTAMPTZ,
    "used_by"         UUID,
    "used_by_name"    TEXT,
    "voided_at"       TIMESTAMPTZ,
    CONSTRAINT "activation_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "activation_codes_code_key" ON "activation_codes"("code");
CREATE INDEX "activation_codes_created_at_idx" ON "activation_codes"("created_at");
