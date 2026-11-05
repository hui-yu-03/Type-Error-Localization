const n1 = 74;
const s2 = "alpha";
const b3 = false;
const xs4 = [62, 74, 2];
const ws5 = ["delta", "key"];
const o6 = { id: 63, name: "item", active: true };
let acc7 = 0;
function f8(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
const n9 = b3 ? n1 : n1;
xs4.push(n1);
function f10(item) {
  const label = item.name + "#" + item.id;
  return label;
}
const ws11 = s2.split(",");
const s12 = ws11.join(", ");
const p13 = Promise.resolve(n1);
if (b3) {
  acc7 = acc7 + n9;
} else {
  acc7 = acc7 - 18;
}
const s14 = o6.name + s2;
const s15 = `${n1}`;
const n16 = s2.length + 21;
const p17 = p13.then(v => v * 39);
const p18 = p13.then(v => v * 20);
const b19 = o6.active && b3;
if (b3) {
  acc7 = acc7 + n1;
} else {
  acc7 = acc7 - 25;
}
if (b3) {
  acc7 = acc7 + n16;
} else {
  acc7 = acc7 - 36;
}
const n20 = xs4.length + 35;
const xs21 = [n1, n1, 23];
const o22 = { id: n16, name: s14, active: b19 };
const s23 = f10(o22);
const s24 = s14.padStart(50, "0");
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const s25 = f10(o6);
const n26 = b3 ? n1 : n20;
o6.name = s14;
o22.id = n1 + 1;
const xs27 = [n20, n26, 78];
const ws28 = s23.split(",");
const ws29 = s14.split(",");
async function g30(k) {
  const w = await p13;
  return w * k;
}
const p31 = g30(n20);
