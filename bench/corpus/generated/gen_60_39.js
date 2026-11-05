const n1 = 27;
const s2 = "item";
const b3 = false;
const xs4 = [4, 25, 29];
const ws5 = ["user", "tag"];
const o6 = { id: 1, name: "item", active: true };
let acc7 = 0;
function f8(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
if (b3) {
  acc7 = acc7 + n1;
} else {
  acc7 = acc7 - 47;
}
const n9 = Math.max(n1, n1);
const n10 = Math.max(n1, n1);
const s11 = f8(s2, n9);
const n12 = n1 * 80 + n1;
const o13 = { id: n1, name: s2, active: b3 };
const p14 = Promise.resolve(n10);
const s15 = f8(s2, n12);
const s16 = o13.name + s2;
const s17 = f8(s2, n1);
const o18 = { id: n1, name: s17, active: b3 };
const s19 = f8(s2, n9);
const s20 = f8(s19, n10);
const s21 = `${s2}:${n1}`;
const s22 = s17.toUpperCase();
const o23 = { id: n1, name: s11, active: b3 };
async function g24(k) {
  const w = await p14;
  return w * k;
}
const p25 = g24(n1);
xs4.push(n9);
const s26 = s21.repeat(2);
const s27 = s26.toUpperCase();
const n28 = xs4[0] * 84;
async function g29(k) {
  const w = await p14;
  return w * k;
}
const p30 = g29(n1);
o6.name = s27;
const s31 = o13.name + s19;
const xs32 = [n10, n1, 27];
const b33 = xs32.includes(n1);
function f34(item) {
  const label = item.name + "#" + item.id;
  return label;
}
async function g35(k) {
  const w = await g29(k);
  return w + n10;
}
const p36 = g35(n12);
const p37 = Promise.resolve(n1);
const s38 = ws5.join(", ");
