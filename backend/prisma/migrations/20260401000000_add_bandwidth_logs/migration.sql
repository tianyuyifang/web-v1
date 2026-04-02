-- CreateTable
CREATE TABLE "bandwidth_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "bandwidth_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bandwidth_logs_user_id_date_key" ON "bandwidth_logs"("user_id", "date");

-- AddForeignKey
ALTER TABLE "bandwidth_logs" ADD CONSTRAINT "bandwidth_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
