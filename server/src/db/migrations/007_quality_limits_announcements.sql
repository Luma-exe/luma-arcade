-- Stream quality per play session, summed from the stream page's samples
-- (one every 30 s, see playLog.ts recordQuality): averages are sum/samples.
ALTER TABLE play_sessions ADD COLUMN q_samples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_kbps_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_fps_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_rtt_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_rtt_max REAL NOT NULL DEFAULT 0;
-- frames shown / dropped and packets received / lost, over the samples
ALTER TABLE play_sessions ADD COLUMN q_frames INTEGER NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_dropped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_packets INTEGER NOT NULL DEFAULT 0;
ALTER TABLE play_sessions ADD COLUMN q_lost INTEGER NOT NULL DEFAULT 0;
-- samples that were choppy, laggy or lossy
ALTER TABLE play_sessions ADD COLUMN q_bad INTEGER NOT NULL DEFAULT 0;
-- last known picture size ("1920x1080") and whether it went through TURN
ALTER TABLE play_sessions ADD COLUMN q_size TEXT;
ALTER TABLE play_sessions ADD COLUMN q_relay INTEGER NOT NULL DEFAULT 0;
-- joined someone else's game as player 2
ALTER TABLE play_sessions ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;

-- Play time limits per person (NULL = no limit), in minutes.
ALTER TABLE user_access ADD COLUMN daily_minutes INTEGER;
ALTER TABLE user_access ADD COLUMN weekly_minutes INTEGER;

-- Messages an admin posts for everyone: shown on the arcade's home screen
-- and once on stream pages. Times are epoch ms; expires_at NULL = until
-- removed.
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
