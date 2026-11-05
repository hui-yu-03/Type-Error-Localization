const n1 = 43;
const s2 = "alpha";
const b3 = true;
const xs4 = [37, 11, 1];
const ws5 = ["path", "gamma"];
const o6 = { id: 32, name: "item", active: true };
let acc7 = 0;
function f8(item) {
  const label = item.name + "#" + item.id;
  return label;
}
const b9 = o6.active && b3;
const p10 = Promise.resolve(n1);
const b11 = xs4.includes(n1);
const n12 = b3 ? n1 : n1;
const o13 = { id: n1, name: s2, active: b3 };
const n14 = Math.max(n1, n1);
const s15 = f8(o6);
const p16 = p10.then(v => "#" + v);
const s17 = f8(o13);
const o18 = { id: n1, name: s15, active: b3 };
const n19 = xs4[2] * 22;
const s20 = `${s2}:${n14}`;
const s21 = f8(o13);
const n22 = o18.id + n1;
const s23 = ws5.join(", ");
const p24 = p10.then(v => v * 61);
async function g25(k) {
  const w = await p10;
  return w * k;
}
const p26 = g25(n19);
const n27 = o6.id + n1;
const n28 = n19 * 11 + n22;
const n29 = Math.max(n27, n27);
const p30 = p24.then(v => v * 14);
function f31(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
async function g32(k) {
  const w = await g25(k);
  return w + n28;
}
const p33 = g32(n28);
o13.id = n28 + 64;
const s34 = s21.toUpperCase();
const n35 = s23.length + 60;
function f36(item) {
  const label = item.name + "#" + item.id;
  return label;
}
function f37(item) {
  const label = item.name + "#" + item.id;
  return label;
}
async function g38(k) {
  const w = await g32(k);
  return w + n1;
}
const p39 = g38(n35);
