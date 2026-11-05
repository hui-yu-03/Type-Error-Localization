// typeof-guard flow sensitivity: body constraints go to shadow TVs so the
// parameter picks up only the guard types as a union.
function check(value) {
  if (typeof value === 'string') {
    var s = value.trim();
  }
  if (typeof value === 'number') {
    var n = Math.abs(value);
  }
}
