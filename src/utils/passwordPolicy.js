// Password rules shared by sign-up, reset, change and panel-password forms.
// Length is capped because bcrypt only reads the first 72 bytes and very long
// inputs are a cheap way to burn CPU; the list below is the handful of
// passwords that show up in every breach.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', '12345678', '123456789', '1234567890', '123123123', '11111111', '00000000',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'abc12345', 'abcd1234', 'iloveyou', 'welcome1', 'welcome123', 'admin123',
  'letmein1', 'monkey123', 'dragon123', 'football1', 'baseball1', 'sunshine1', 'princess1', 'passw0rd', 'p@ssw0rd', 'crowdwide',
  'crowdwide1', 'crowdwide123', 'india123', 'india@123', 'test1234', 'changeme', 'zaq12wsx', '1q2w3e4r', '1qaz2wsx'
]);

const MIN = 8;
const MAX = 128;

// Returns an error message, or '' when the password is acceptable.
function passwordProblem(password, { email = '', name = '' } = {}) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < MIN) return `Use a password of at least ${MIN} characters.`;
  if (value.length > MAX) return `Use a password of at most ${MAX} characters.`;
  const lower = value.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(value)) return 'That password is too easy to guess. Try a longer phrase that is not a common password.';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Your password should not contain your email name.';
  const first = String(name).trim().split(/\s+/)[0].toLowerCase();
  if (first.length >= 4 && lower === first) return 'Your password should not be just your name.';
  return '';
}

module.exports = { passwordProblem, MIN, MAX };
