CREATE TABLE "attendance_operations" (
  "id" varchar(64) PRIMARY KEY,
  "sessionId" uuid NOT NULL REFERENCES "work_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" varchar(16) NOT NULL
);
