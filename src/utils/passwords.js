const bcrypt = require('bcryptjs');

// bcryptjs is pure JavaScript, so every hash/compare burns real CPU on the
// single Node thread. Cost 12 (~4x the work of 10) makes sign-in and sign-up
// feel sluggish on small/shared hosts. Cost 10 is still the commonly
// recommended minimum. Override with BCRYPT_ROUNDS if your host has more CPU.
// Existing hashes keep working at whatever cost they were created with.
const rounds = Math.min(14, Math.max(8, Number(process.env.BCRYPT_ROUNDS) || 10));

const hashPassword = (plain) => bcrypt.hash(plain, rounds);

module.exports = { hashPassword, BCRYPT_ROUNDS: rounds };
