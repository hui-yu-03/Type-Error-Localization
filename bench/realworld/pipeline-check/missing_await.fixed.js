const p = Promise.resolve(41);
async function next(k) {
  const w = await p;
  return w * k;
}
const q = next(2);
