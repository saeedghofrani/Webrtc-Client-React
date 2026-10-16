const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const socket = net.connect(3478, process.env.TURN_HOST || 'meet.saeedghofrani.xyz');
socket.setTimeout(8000);
socket.once('connect', () => {
  const request = Buffer.alloc(28);
  request.writeUInt16BE(0x0003, 0); // Allocate request without credentials.
  request.writeUInt16BE(8, 2); request.writeUInt32BE(0x2112a442, 4);
  crypto.randomBytes(12).copy(request, 8);
  request.writeUInt16BE(0x0019, 20); request.writeUInt16BE(4, 22); request[24] = 17;
  socket.write(request);
});
let response = Buffer.alloc(0);
socket.on('data', (data) => {
  response = Buffer.concat([response, data]);
  if (response.length < 20 || response.length < 20 + response.readUInt16BE(2)) return;
  try {
    assert.equal(response.readUInt16BE(0), 0x0113, 'unauthenticated allocation must fail');
    let code;
    for (let offset = 20; offset + 4 <= response.length;) {
      const type = response.readUInt16BE(offset), length = response.readUInt16BE(offset + 2);
      if (type === 0x0009) code = (response[offset + 6] & 7) * 100 + response[offset + 7];
      offset += 4 + Math.ceil(length / 4) * 4;
    }
    assert.equal(code, 401);
    console.log('PASS: TURN rejects unauthenticated allocation with 401');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  socket.destroy();
});
socket.on('timeout', () => socket.destroy(new Error('TURN authentication probe timed out')));
socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
