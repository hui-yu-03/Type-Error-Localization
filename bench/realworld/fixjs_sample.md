# FixJS: a random sample classified by hand

30 random small fixes (at most 3 changed lines) among the 288 FixJS pairs whose version before the fix is ill-typed and the version after it well typed (strict type system, `random.Random(11)`). **R**: the bug is a type-related mistake (a value used at the wrong type, a member or function that does not exist, a wrong variable); **S**: spurious, the fix changed something else and removed a false alarm on the way; **U**: unclear without more context. Ranks: of the first changed line, for the first-conflict checker (solver.js) and the full pipeline (– : not ranked).

| # | pair | class | what the fix does | first conflict | full pipeline |
|---|---|---|---|---|---|
| 1 | `50-100/39973e96ddcffa232a8516b0e9aeedcab388dd92_1_1` | R | for-in over an array used as if it gave the elements | – | 2 |
| 2 | `50-100/f2f3edfa94cbec56765c839a1f1ca994710c8d6b_1_1` | S | return false instead of preventing the event (behaviour) | – | 1 |
| 3 | `50-100/464e7525505cd86faa1c3ead6af1ea92905c7740_0_1` | S | path resolved with realpathSync (behaviour) | 1 | 2 |
| 4 | `50-100/a9dccc78139ef090a2b95100e5c2720271d51dc0_0_1` | R | params compared with "" but may be undefined or an object | – | 2 |
| 5 | `100+/eaa860b7c1b092289889da545d01cfa54efad12a_0_2` | R | bg.draw() is not a method (API renamed to render) | – | 4 |
| 6 | `100+/e9bbcd469773545be215b0595339c1823ce81790_0_8` | R | root.isSet is no property (wrong check) | – | 3 |
| 7 | `50-100/b07a79152f5a2dfa113545761cfb734488041809_0_1` | U | null handling of a name (unclear) | 1 | 1 |
| 8 | `50-100/4fe4610dfce739f5a24211c39be26376ac129793_0_1` | R | test expected strings, the values are numbers | 1 | 3 |
| 9 | `100+/ea8d54f5359a0e6c25559aa60e7f3fca88202bb6_1_1` | R | path.existsSync instead of fs.existsSync | 1 | 1 |
| 10 | `100+/7117abd674058ebda0b39b9e2d1d8ccd5de645ea_0_1` | S | object literal key html instead of value (and a trailing comma) | – | 1 |
| 11 | `50-100/33b0a687b5e5b3069b82bd239c20385cf84ddd6d_0_1` | R | this.map instead of this.mapModel | 1 | 2 |
| 12 | `50/959929f29700ce33c0b115db7b2cd032b02a82f9_2_3` | S | duck typing method.call replaced by _.isFunction (refactoring) | – | 1 |
| 13 | `100+/b54d58e496c0f4e5eb854423e5068d910a2b6032_1_1` | S | configuration copied differently (refactoring) | – | 2 |
| 14 | `100+/6fa66cd965a2d024ab3978acb5ca92e92f6f0076_1_2` | S | test assertions rewritten (refactoring) | – | 5 |
| 15 | `50-100/c7e93092ee6e8f1a40cbc29bb01767282e1009e5_3_1` | S | extension check moved into a helper (refactoring) | 1 | 1 |
| 16 | `100+/327429459286fdbf57a4cf74230e2d5b9fb04466_0_1` | R | attribute value "6px" instead of 6 | – | 3 |
| 17 | `50-100/14b6845cc2276d695d1ff04b2cc03c99c6d22d01_0_1` | R | Dialog.effect instead of exports.effect | – | 1 |
| 18 | `100+/c247e491e2eb43dd528a76b1695560de4837bb6a_1_1` | U | +depth check removed (unclear) | 1 | 1 |
| 19 | `100+/0d414eaeae13bb520e52ddace0a83c03eb9e7769_0_1` | R | !x === "str": ! binds first (precedence) | 1 | 1 |
| 20 | `50-100/c147e6fea00fc3f8af915bc29b566cbc4882ee3d_0_1` | R | mime instead of this.mime | 1 | 1 |
| 21 | `100+/43f199b2fdfc60defb33f54ca0c32f9e4fb0e84b_0_1` | S | return; instead of return null | – | 2 |
| 22 | `100+/40a0950df3e0b940396eb0bafdd73eb01ad13975_0_2` | S | debugging alert(...) calls removed | – | 1 |
| 23 | `100+/2ff16723352c38097ce55934f43a4baa9e2a2e0f_0_1` | R | for-in over an array used as if it gave the elements | 1 | 1 |
| 24 | `50/387f37ab010cbb9c5c9d5ee71e3eff794eef6d4c_1_1` | R | return "" in a function that returns arrays | 1 | 1 |
| 25 | `100+/281876edcd801e15c439ae0497c51c5dbde89478_0_1` | R | path.existsSync instead of fs.existsSync | 1 | 1 |
| 26 | `50-100/4511f12088973942274a0b57a3b1bbaa13b822ba_0_3` | S | DOM element styled instead of the jQuery object (refactoring) | 1 | 4 |
| 27 | `50/b4ca76c0d3a70fea6ae260db4d95732ac25c60b2_0_1` | R | weapons.push[key] instead of weapons.push(key) | 1 | 1 |
| 28 | `50-100/31c18e69b4d54fa584af7b70b78d4c2373249997_4_1` | S | a call commented out (behaviour) | 1 | 1 |
| 29 | `50/00476b0122f8a0baa302c45bc18cb781af0f4edc_1_5` | R | (x / 100).round(): round is no number method | 1 | 1 |
| 30 | `50-100/ba1cb1429d9047c3bde63bde9abc03642a93efcf_1_3` | R | var re-declaration shadows the variable it reads | 1 | 1 |

R 17, S 11, U 2. On the 17 real bugs: first conflict top-1 11, top-3 11; full pipeline top-1 10, top-3 16.
