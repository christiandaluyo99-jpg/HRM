CREATE DATABASE the_aster CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hrm_app'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON the_aster.* TO 'hrm_app'@'localhost';

CREATE TABLE IF NOT EXISTS admin_accounts (
  email VARCHAR(191) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  position VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS room_types (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  nightly_rate DECIMAL(10, 2) NOT NULL,
  capacity TINYINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rooms (
  room_number VARCHAR(8) NOT NULL PRIMARY KEY,
  room_type_id INT UNSIGNED NOT NULL,
  CONSTRAINT fk_rooms_room_type FOREIGN KEY (room_type_id)
    REFERENCES room_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  guest_name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(32) NOT NULL DEFAULT '',
  room_type VARCHAR(100) NOT NULL,
  room_number VARCHAR(8) NOT NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  guests TINYINT UNSIGNED NOT NULL,
  status ENUM('Reserved', 'Checked in', 'Checked out', 'Cancelled') NOT NULL,
  INDEX idx_reservations_room_dates (room_number, check_in, check_out),
  INDEX idx_reservations_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_activity (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  actor VARCHAR(80) NOT NULL,
  email VARCHAR(191) NOT NULL,
  action VARCHAR(120) NOT NULL,
  details VARCHAR(1000) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_admin_activity_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_lock (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;

INSERT IGNORE INTO app_lock (id) VALUES (1);
