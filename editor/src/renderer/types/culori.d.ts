declare module 'culori' {
  export type Color = any;

  export const converter: (...args: any[]) => (...args: any[]) => any;
  export const parse: (value: string) => Color | undefined;
  export const formatHex: (color: Color) => string;
  export const formatHex8: (color: Color) => string;
  export const formatRgb: (color: Color) => string;
  export const formatCss: (color: Color) => string;
  export const toGamut: (...args: unknown[]) => (color: Color) => Color;
  export const wcagContrast: (foreground: Color, background: Color) => number;
}
