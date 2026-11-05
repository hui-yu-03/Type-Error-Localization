const n1 = 30;
const s2 = "node";
const b3 = false;
const xs4 = [17, 25, 91];
const ws5 = ["alpha", "beta"];
const o6 = { id: 18, name: "delta", active: true };
let acc7 = 0;
const p8 = Promise.resolve(n1);
const b9 = n1 > n1;
const o10 = { id: n1, name: s2, active: b9 };
const s11 = s2 + "-" + n1;
const o12 = { id: n1, name: s2, active: b3 };
const n13 = n1 - n1;
const n14 = n1 * 89 + n13;
async function g15(k) {
  const w = await p8;
  return w * k;
}
const p16 = g15(n14);
const p17 = p16.then(v => v * 90);
const s18 = `${n1}`;
async function g19(k) {
  const w = await g15(k);
  return w + n1;
}
const p20 = g19(n13);
const n21 = n1 - n13;
const b22 = xs4.includes(n21);
const n23 = o6.id + n21;
async function g24(k) {
  const w = await p8;
  return w * k;
}
const p25 = g24(n23);
const s26 = s11 + "-" + n23;
const n27 = o10.id + n1;
async function g28(k) {
  const w = await g19(k);
  return w + n27;
}
const p29 = g28(n1);
const p30 = Promise.resolve(n1);
const n31 = n27 - n13;
const b32 = s11.startsWith("d");
const n33 = b22 ? n31 : n31;
function f34(x, y) {
  const t = x * y;
  return t + 11;
}
const n35 = f34(n14, n27);
const n36 = f34(n35, n35);
const b37 = s26 === s18;
const b38 = o12.active && b3;
const s39 = s2 + "-" + n21;
const p40 = p29.then(v => v * 56);
const xs41 = [n31, n33, 61];
const p42 = p20.then(v => v * 83);
const n43 = b32 ? n36 : n13;
o6.name = s39;
const n44 = n43 - n31;
