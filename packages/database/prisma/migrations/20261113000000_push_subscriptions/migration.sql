CREATE TABLE "push_subscriptions" (
    "endpoint" TEXT PRIMARY KEY,
    "sessionId" UUID NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL
);
CREATE INDEX "push_subscriptions_sessionId_idx" ON "push_subscriptions"("sessionId");
