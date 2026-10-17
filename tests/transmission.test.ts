import { describe, expect, it } from "vitest";
import { simplify } from "../scripts/build-transmission";
import { classifyKv, lineProps, parseVoltageKv } from "../src/lib/transmission";

describe("OSM voltage parsing", () => {
  it("reads volts, multi-circuit lists and junk", () => {
    expect(parseVoltageKv("230000")).toEqual([230]);
    expect(parseVoltageKv("230000;115000")).toEqual([230, 115]);
    expect(parseVoltageKv("115000;500000;115000")).toEqual([500, 115]);
    expect(parseVoltageKv("medium")).toEqual([]);
    expect(parseVoltageKv(undefined)).toEqual([]);
  });

  it("classes lines by their highest voltage", () => {
    expect(classifyKv(500)).toBe("500");
    expect(classifyKv(345)).toBe("500");
    expect(classifyKv(230)).toBe("230");
    expect(classifyKv(220)).toBe("230");
    expect(classifyKv(115)).toBe("115");
    expect(classifyKv(120)).toBe("115");
    expect(classifyKv(44)).toBe("sub");
    expect(classifyKv(null)).toBe("unknown");
    expect(lineProps(1, { power: "line", voltage: "500000;230000", ref: "B560V" })).toMatchObject({ vclass: "500", kv: 500, voltages: "500 kV / 230 kV", ref: "B560V", cable: false });
    expect(lineProps(2, { power: "cable" })).toMatchObject({ vclass: "unknown", kv: null, cable: true });
  });
});

describe("line simplification", () => {
  it("drops collinear points and keeps corners", () => {
    const pts: [number, number][] = [[0, 0], [0.5, 0.00001], [1, 0], [1, 1]];
    expect(simplify(pts, 0.001)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});
