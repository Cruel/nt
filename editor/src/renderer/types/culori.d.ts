declare module 'culori' {
  export interface Color {
    mode: string;
    alpha?: number;
    [channel: string]: string | number | undefined;
  }

  export interface RgbColor extends Color {
    r?: number;
    g?: number;
    b?: number;
  }

  export interface HslColor extends Color {
    h?: number;
    s?: number;
    l?: number;
  }

  export interface HsvColor extends Color {
    h?: number;
    s?: number;
    v?: number;
  }

  export interface OklabColor extends Color {
    l?: number;
    a?: number;
    b?: number;
  }

  export interface OklchColor extends Color {
    l?: number;
    c?: number;
    h?: number;
  }

  export function converter(mode: 'rgb' | 'p3' | 'rec2020'): (color: Color) => RgbColor | undefined;
  export function converter(mode: 'hsl'): (color: Color) => HslColor | undefined;
  export function converter(mode: 'hsv'): (color: Color) => HsvColor | undefined;
  export function converter(mode: 'oklab'): (color: Color) => OklabColor | undefined;
  export function converter(mode: 'oklch'): (color: Color) => OklchColor | undefined;
  export const parse: (value: string) => Color | undefined;
  export const formatHex: (color: Color) => string;
  export const formatHex8: (color: Color) => string;
  export const formatRgb: (color: Color) => string;
  export const formatCss: (color: Color) => string;
  export const toGamut: (mode: string, method?: string) => (color: Color) => Color | undefined;
  export const wcagContrast: (foreground: Color, background: Color) => number;
}
