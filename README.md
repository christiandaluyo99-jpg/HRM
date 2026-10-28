# HRM

## Run with MySQL

The app now stores reservations, room inventory, administrator accounts, and
activity history in MySQL. Serve it through the Node.js server; do not open
`index.html` directly or use a static-only development server.

1. Create a MySQL database and application user, then grant that user access to
   the database:

   ```sql
   CREATE DATABASE the_aster CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'hrm_app'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
   GRANT ALL PRIVILEGES ON the_aster.* TO 'hrm_app'@'localhost';
   ```

2. Copy `.env.example` to `.env` and set the MySQL connection values, a unique
   `SESSION_SECRET` of at least 32 characters, and the initial administrator
   email/password. The initial password must be at least 12 characters.
3. Install dependencies and start the app:

   ```sh
   npm install
   npm start
   ```

   Open `http://localhost:3000`. On first startup the server creates the tables,
   default room inventory, and initial administrator account. Keep `.env`
   private and change the sample values before deployment.

For a managed MySQL service, set `MYSQL_SSL=true` if it requires TLS. Set
`NODE_ENV=production` behind HTTPS so the sign-in cookie is marked secure.
The server uses an HTTP-only, signed eight-hour session cookie; administrator
passwords are bcrypt-hashed before they are stored. Do not expose the Node.js
port directly to the public internet without HTTPS and appropriate deployment
controls.

## Backups and local preferences

In **Administrator → Property tools**, download a JSON backup to preserve
reservations, room inventory, the current administrator profile, and activity
history from MySQL. Restoring a backup replaces those database records. Export
reservations as CSV for spreadsheets; CSV exports are not recovery backups.
Records from the older browser-only version are not uploaded automatically.
Export a JSON backup from that version and restore it here to transfer them.

The Administrator section's optional 15-minute idle lock and theme preference
are browser-local convenience settings. The idle lock is not a replacement for
administrator sign-in.