import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { Store } from "../src/store.js";

const id = "demo-reading-study";
const title = "A Demonstration Study of Deliberate Reading Notes";
const authors = "Paper Reading League Demo Team";
const serif = GlobalFonts.has("Georgia") ? "Georgia" : "Liberation Serif";
const sans = GlobalFonts.has("Arial") ? "Arial" : "DejaVu Sans";
const sections = [
  [
    "Purpose and design",
    "This is original demonstration material for the Paper Reading League. It is not a published study and does not report a real experiment. The sample asks a practical teaching question: can a structured reading note help a learner distinguish a claim, a method, a result, and a limitation? Three fictional reading sessions are described so that participants can practice writing evidence-aware summaries.",
    "The teaching design gives each participant a short research-style text and a note sheet with four prompts. The prompts ask what problem motivates the work, how the observation was made, which result supports the claim, and what remains uncertain. The expected outcome is not a score but a traceable explanation in the reader’s own words.",
  ],
  [
    "Method and illustrative results",
    "In the demonstration protocol, twelve imaginary participants read the same three-page sample during a timed session. Half use unstructured notes and half use the four-prompt sheet. The facilitators compare the presence of explicit evidence and limitations in the final summaries. These numbers are invented examples solely for discussion; they should never be cited as research findings.",
    "The illustrative comparison suggests that structured notes can make summaries easier to inspect. Five of six prompted summaries name a method and a limitation, while two of six unstructured summaries do so. This pattern does not establish causation, effectiveness, or generalization. It merely shows the kind of evidence a careful reader should separate from an attractive conclusion.",
  ],
  [
    "Interpretation and limitations",
    "The sample supports a narrow lesson: a useful reading summary links a claim to the observation that bears on it and states what that observation cannot show. It does not ask readers to accept a result on authority. A reader can discuss whether the fictional measure is appropriate, whether the groups are comparable, and which information would be needed before making a stronger recommendation.",
    "Several limitations are deliberate. The participants, sessions, measurements, and results are synthetic. No statistical inference, preregistration, peer review, or external replication exists. The material is therefore suitable only for practicing research communication. A future real study would need a defined population, transparent measures, an ethical protocol, and independently collected data before any educational claim could be made.",
  ],
] as const;

function wrap(
  context: SKRSContext2D,
  value: string,
  maxWidth: number,
): string[] {
  const words = value.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

export async function seedDemo(store: Store, dataDir: string): Promise<void> {
  const exists = store.getPaper(id);
  const directory = resolve(dataDir, "papers", id);
  await mkdir(directory, { recursive: true });
  const textParts: string[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const canvas = createCanvas(1200, 1550);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fcfcf8";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#13233a";
    context.font = `bold 34px "${serif}"`;
    context.fillText(title, 90, 115, 1020);
    context.font = `22px "${sans}"`;
    context.fillStyle = "#44546a";
    context.fillText(
      "Original teaching sample · not a published paper",
      90,
      158,
    );
    context.fillStyle = "#1d2939";
    context.font = `bold 34px "${serif}"`;
    context.fillText(sections[index][0], 90, 255);
    context.font = `27px "${serif}"`;
    let y = 330;
    for (const paragraph of sections[index].slice(1)) {
      for (const line of wrap(context, paragraph, 1020)) {
        context.fillText(line, 90, y);
        y += 43;
      }
      y += 34;
    }
    context.font = `20px "${sans}"`;
    context.fillStyle = "#52606d";
    context.fillText(
      `Demonstration page ${index + 1} of ${sections.length}`,
      90,
      1470,
    );
    await writeFile(
      join(directory, `page-${index + 1}.png`),
      canvas.toBuffer("image/png"),
    );
    textParts.push(
      `[Page ${index + 1}]\n${title}\nOriginal teaching sample — not a published paper\n${sections[index][0]}\n${sections[index][1]}\n${sections[index][2]}`,
    );
  }
  if (!exists)
    store.addPaper({
      id,
      title,
      authors,
      sourceUrl: "",
      license: "Original demonstration material",
      pageCount: sections.length,
      text: textParts.join("\n\n"),
      directory,
      demo: true,
    });
}
