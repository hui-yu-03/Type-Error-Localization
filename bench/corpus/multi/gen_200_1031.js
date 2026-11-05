const n1 = 90;
const s2 = "tag";
const b3 = true;
const xs4 = [5, 41, 41];
const ws5 = ["alpha", "node"];
const o6 = { id: 81, name: "item", active: true };
let acc7 = 0;
const xs8 = [n1, n1, 62];
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const s9 = s2 + "-" + n1;
function f10(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
const s11 = f10(s2, n1);
function f12(item) {
  const label = item.name + "#" + item.id;
  return label;
}
const p13 = Promise.resolve(n1);
const n14 = s11.length + 76;
const b15 = o6.active && b3;
xs8.push(n1);
const b16 = s11 === s2;
const s17 = `${s11}:${n1}`;
o6.id = n1 + 20;
const p18 = p13.then(v => v * 81);
if (b15) {
  acc7 = acc7 + n1;
} else {
  acc7 = acc7 - 23;
}
const s19 = `${s2}:${n1}`;
const s20 = s2.repeat(1);
const n21 = o6.id + n1;
const s22 = ws5.join(", ");
const s23 = `${s22}:${n1}`;
const s24 = f10(s23, n21);
const s25 = f10(s20, n21);
o6.id = n1 + 18;
const n26 = b15 ? n21 : n1;
const b27 = o6.active && b3;
const n28 = s24.length + 44;
const o29 = { id: n26, name: s24, active: b15 };
const o30 = { id: n21, name: s25, active: b15 };
const n31 = Math.max(n28, n28);
const n32 = b3 ? n28 : n1;
const n33 = n31 - n31;
const b34 = n21 > n33;
const s35 = s11.repeat(2);
function f36(x, y) {
  const t = x * y;
  return t + 32;
}
o30.id = n21 + 61;
const b37 = xs4.includes(n28);
const p38 = p13.then(v => v * 82);
const s39 = `${n32}`;
const ws40 = s24.split(",");
const n41 = o30.id + n26;
const s42 = s39.repeat(2);
const xs43 = [n26, n14, 13];
async function g44(k) {
  const w = await p13;
  return w * k;
}
const p45 = g44(n33);
const o46 = { id: n28, name: s35, active: b34 };
const s47 = `${n32}`;
const s48 = s35.padStart(52, "0");
const n49 = s48.length + 7;
o6.id = n31 + 12;
function f50(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
function f51(x, y) {
  const t = x * y;
  return t + 9;
}
const n52 = n33 - n49;
const p53 = p13.then(v => "#" + v);
const s54 = s47.repeat(1);
const o55 = { id: n41, name: s48, active: b16 };
const s56 = f12(o46);
const s57 = s42 + "-" + n49;
const p58 = Promise.resolve(n33);
const n59 = Math.max(n32, n49);
xs8.push(n28);
const s60 = s47 + "-" + n59;
const ws61 = [s60, s54];
o6.id = n52 + 83;
const xs62 = [n52, n52, 82];
const o63 = { id: n32, name: s24, active: b27 };
const s64 = s56.repeat(2);
const p65 = p13.then(v => v * 76);
const f66 = (a, b) => a * b + 4;
const s67 = f12(o63);
const n68 = Math.max(n41, n14);
const p69 = Promise.resolve(n59);
async function g70(k) {
  const w = await g44(k);
  return w + n59;
}
const p71 = g70(n33);
const s72 = f50(s64, n49);
o63.name = s48;
o63.name = s60;
const xs73 = [n68, n52, 23];
const s74 = f50(s72, n32);
const s75 = f12(o6);
const b76 = n68 > n49;
const s77 = o6.name + s75;
if (b15) {
  acc7 = acc7 + n52;
} else {
  acc7 = acc7 - 35;
}
const b78 = s60.startsWith("k");
const b79 = o63.active && b76;
const s80 = o63.name + s74;
const n81 = b76 ? n68 : n68;
const p82 = p71.then(v => v * 6);
const n83 = xs4.length + 64;
const p84 = p45.then(v => "#" + v);
const n85 = b78 ? n52 : n14;
const s86 = s80.padStart(27, "0");
const n87 = s77.length + 30;
const o88 = { id: n52, name: s56, active: b78 };
function f89(item) {
  const label = item.name + "#" + item.id;
  return label;
}
o88.name = s86;
const p90 = p82.then(v => v * 22);
const n91 = n52 * 56 + n81;
const xs92 = [n85, n91, 32];
async function g93(k) {
  const w = await g70(k);
  return w + n87;
}
const p94 = g93(n91);
const s95 = f12(o46);
const b96 = s77 === s95;
const s97 = s77.padStart(43, "0");
const xs98 = [n87, n49, 99];
async function g99(k) {
  const w = await g93(k);
  return w + n83;
}
const p100 = g99(n87);
const n101 = Math.max(n31, n91);
const n102 = b96 ? n85 : n68;
const b103 = s86.startsWith("p");
const n104 = s95.length + 4;
const s105 = f89(o88);
const xs106 = [n102, n83, 94];
async function g107(k) {
  const w = await g44(k);
  return w + n104;
}
const p108 = g107(n21);
const f109 = (a, b) => a * b + 29;
for (let i = 0; i < xs62.length; i++) {
  acc7 = acc7 + xs62[i];
}
const xs110 = [n101, n87, 5];
const ws111 = s97.split(",");
const s112 = ws5.join(", ");
const n113 = n85 - n104;
const n114 = n85 - n87;
const n115 = o30.id + n114;
const n116 = n115 * 16 + n102;
for (let i = 0; i < xs62.length; i++) {
  acc7 = acc7 + xs62[i];
}
const o117 = { id: n104, name: s105, active: b78 };
const s118 = s86.toUpperCase();
const s119 = s112.repeat(2);
o117.id = n116 + 53;
const n120 = n102 * 55 + n114;
const s121 = ws40.join(", ");
const s122 = f89(o46);
const p123 = p108.then(v => v * 24);
const p124 = Promise.resolve(n120);
const s125 = f10(s118, n120);
const p126 = Promise.resolve(n120);
const n127 = xs110[0] * 89;
const p128 = p124.then(v => v * 43);
async function g129(k) {
  const w = await g44(k);
  return w + n115;
}
const p130 = g129(n114);
const p131 = p126.then(v => "#" + v);
async function g132(k) {
  const w = await g93(k);
  return w + n113;
}
const p133 = g132(n115);
