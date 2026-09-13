import type { DatabaseMigrationDefinition } from "./catalog";

export const messageChronologyMigration: DatabaseMigrationDefinition = {
  name: "IndexMessageSearchChronology",
  up: "CREATE INDEX messages_created_id_idx ON messages(created_at DESC, id DESC);",
};

export const privateConnectMessageOriginMigration: DatabaseMigrationDefinition = {
  name: "PersistPrivateConnectMessageOrigin",
  up: `ALTER TABLE messages ADD COLUMN private_connect_device_id TEXT
    CHECK (private_connect_device_id IS NULL OR (
      role = 'user' AND length(private_connect_device_id) = 36
      AND lower(private_connect_device_id) NOT GLOB '*[^0-9a-f-]*'
      AND substr(private_connect_device_id, 9, 1) = '-'
      AND substr(private_connect_device_id, 14, 1) = '-'
      AND substr(private_connect_device_id, 19, 1) = '-'
      AND substr(private_connect_device_id, 24, 1) = '-'
    ));`,
};
