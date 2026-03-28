-- When each user last viewed each document
CREATE TABLE document_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);

-- Documents a user is watching (explicit subscription)
CREATE TABLE document_watches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);
--> statement-breakpoint
CREATE INDEX watches_doc_idx ON document_watches(document_id);

-- Notifications (read status derived from document_reads)
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE SET NULL,
  space_slug text NOT NULL,
  doc_slug text NOT NULL,
  title text NOT NULL,
  body text,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
