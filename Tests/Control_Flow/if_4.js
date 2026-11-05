// The ! operator does not constrain its operand to bool.
// 'input' is str — applying ! must not cause a str/bool conflict.
var input = "";

if (!input) {
  input = "default";
}

// Likewise, || does not constrain its operands.
var fallback = input || "none";
