import { describe, expect, it } from "vitest";
import { maskOffensive, tokenTextReviver } from "../../apps/web/src/lib/tokenText.js";

describe("token text masking", () => {
  it("masks slurs, keeping the first letter and the length", () => {
    expect(maskOffensive("RETARD COIN")).toBe("R***** COIN");
    expect(maskOffensive("RetardCoin")).toBe("R*********");
    expect(maskOffensive("the fag token")).toBe("the f** token");
  });

  it("leaves innocent words that contain a short slur alone", () => {
    for (const s of ["Grape Juice", "Raccoon", "Custard", "Spice", "Pakistan", "Dykeman"]) expect(maskOffensive(s)).toBe(s);
  });

  it("applies only to token text fields, never to addresses or other values", () => {
    const body = JSON.parse('{"token":{"name":"retard","symbol":"RAPE","mint":"retardXyz"},"label":"retard"}', tokenTextReviver);
    expect(body).toEqual({ token: { name: "r*****", symbol: "R***", mint: "retardXyz" }, label: "retard" });
  });
});
