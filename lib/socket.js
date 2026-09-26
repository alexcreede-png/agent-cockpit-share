'use strict';
// Unix-socket listener setup. A loopback TCP port can be reached by every process and every
// user on the machine, and any of them can forge the Tailscale identity headers. A socket
// file readable only by its owner cannot; tailscaled runs as root, so it can still connect.
const fs = require('fs');
const path = require('path');

// Make sure the socket's directory is private to us, then clear a stale socket.
// Throws (refusing to start) rather than loosening permissions on a directory we didn't make.
function prepareSocket(socketPath) {
  if (!path.isAbsolute(socketPath)) throw new Error('cockpit: socketPath must be absolute');
  const dir = path.dirname(socketPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error(`cockpit: ${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`cockpit: ${dir} must be owned by you`);
  if (st.mode & 0o077) throw new Error(`cockpit: ${dir} must not be accessible to others (chmod 700 it)`);
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error(`cockpit: ${socketPath} exists and is not a socket`);
    fs.unlinkSync(socketPath);
  }
}

// Called once the server is listening.
const lockSocket = (socketPath) => fs.chmodSync(socketPath, 0o600);

module.exports = { prepareSocket, lockSocket };
