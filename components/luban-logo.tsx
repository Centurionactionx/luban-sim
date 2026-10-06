import type { SVGProps } from "react";

// The Luban logo, drawn inline so it follows the theme: the bridge is always
// the logo lavender, and "Ban" in the wordmark takes the surrounding text
// colour (ink on light, white on dark). The same artwork lives as standalone
// files in public/brand/ for places outside React.

type LogoProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "children">;

/** The bridge on its own. */
export function LubanMark(props: LogoProps) {
  return (
    <svg viewBox="6 14 180 124" aria-hidden="true" focusable="false" {...props}>
      <g fill="none" stroke="#7b6cd3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M65 88.5 V23 Q65 20.5 67.5 20.5 H72 Q74.5 20.5 74.5 23 V87.8 M126 88.5 V23 Q126 20.5 123.5 20.5 H119 Q116.5 20.5 116.5 23 V87.8" strokeWidth="5.5" />
        <path d="M74.5 23 H116.5 M74.5 30.5 H116.5" strokeWidth="4.5" />
        <path d="M65 27 Q38 60 10.5 82 M126 27 Q153 60 180.5 82" strokeWidth="5.5" />
        <path d="M38.5 56.6 V91.9 M152.5 56.6 V91.9" strokeWidth="5" />
        <path d="M12 98 Q95.5 78 179 98 L179 104.5 Q95.5 86.5 12 104.5 Z" strokeWidth="4.5" />
        <path d="M24.5 133.5 V122.5 A12.5 12.5 0 0 1 49.5 122.5 V133.5 Z M166.5 133.5 V122.5 A12.5 12.5 0 0 0 141.5 122.5 V133.5 Z" strokeWidth="5" />
      </g>
    </svg>
  );
}

/** "LuBan": "Lu" in the logo lavender, "Ban" in the current text colour. */
export function LubanWordmark(props: LogoProps) {
  return (
    <svg viewBox="29 140 130 31" aria-hidden="true" focusable="false" {...props}>
      <g transform="translate(27.74 169.5) scale(0.4028)">
        <path fill="#7b6cd3" d="M25.20-70.50L25.20-15L47.10-15L47.10 0L5.60 0L5.60-70.50" />
        <path fill="#7b6cd3" d="M94.19-56.10L113.89-56.10L113.89 0L94.19 0L94.19-8Q91.69-4.20 87.29-1.85Q82.89 0.50 77.19 0.50Q67.39 0.50 61.74-5.95Q56.09-12.40 56.09-23.50L56.09-56.10L75.59-56.10L75.59-26Q75.59-21.20 78.14-18.45Q80.69-15.70 84.89-15.70Q89.19-15.70 91.69-18.45Q94.19-21.20 94.19-26" />
        <path fill="currentColor" d="M171.87-36.20Q178.07-34.80 181.72-30.05Q185.37-25.30 185.37-19.20Q185.37-10.20 179.17-5.10Q172.97 0 161.77 0L126.87 0L126.87-70.50L160.67-70.50Q171.47-70.50 177.62-65.70Q183.77-60.90 183.77-52.20Q183.77-46 180.52-41.85Q177.27-37.70 171.87-36.20M146.47-54.90L146.47-42.50L156.37-42.50Q163.77-42.50 163.77-48.60Q163.77-54.90 156.37-54.90L146.47-54.90M157.87-15.80Q165.27-15.80 165.27-22Q165.27-25.20 163.32-26.90Q161.37-28.60 157.77-28.60L146.47-28.60L146.47-15.80" />
        <path fill="currentColor" d="M192.56-28.10Q192.56-36.80 195.71-43.30Q198.86-49.80 204.31-53.30Q209.76-56.80 216.46-56.80Q222.26-56.80 226.46-54.50Q230.66-52.20 232.96-48.30L232.96-56.10L252.56-56.10L252.56 0L232.96 0L232.96-7.80Q230.66-3.90 226.41-1.60Q222.16 0.70 216.46 0.70Q209.76 0.70 204.31-2.80Q198.86-6.30 195.71-12.85Q192.56-19.40 192.56-28.10M232.96-28.10Q232.96-33.50 230.01-36.60Q227.06-39.70 222.76-39.70Q218.36-39.70 215.46-36.65Q212.56-33.60 212.56-28.10Q212.56-22.70 215.46-19.55Q218.36-16.40 222.76-16.40Q227.06-16.40 230.01-19.50Q232.96-22.60 232.96-28.10" />
        <path fill="currentColor" d="M302.25-56.60Q311.95-56.60 317.65-50.15Q323.35-43.70 323.35-32.70L323.35 0L303.75 0L303.75-30.10Q303.75-34.90 301.25-37.65Q298.75-40.40 294.55-40.40Q290.15-40.40 287.65-37.65Q285.15-34.90 285.15-30.10L285.15 0L265.55 0L265.55-56.10L285.15-56.10L285.15-48.10Q287.75-51.90 292.15-54.25Q296.55-56.60 302.25-56.60" />
      </g>
    </svg>
  );
}
