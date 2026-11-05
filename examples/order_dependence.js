function label(text, k) {
  const head = text.toUpperCase();
  return head + k;
}
const xs = [1, 2, 3];
const n = xs.length + 2;
const s = label("a", n);
