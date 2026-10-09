import { Inter } from "next/font/google";

// CENTERIVO's one typeface. Loaded only where a CENTERIVO surface renders
// (the Admin shell and the internal sign-in / business chooser), never in
// the root layout, so the customer-facing ordering site keeps its own font
// and never preloads this one. The variable is consumed by `.centerivo` in
// globals.css; weights come from the variable font (Regular body, Medium
// controls, SemiBold headings and figures).
export const centerivoSans = Inter({
  variable: "--font-centerivo-sans",
  subsets: ["latin"],
  display: "swap",
});
