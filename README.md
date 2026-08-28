# Doc → AI Text

> **Educational use only.** This project is published for learning and demonstration.
> Commercial use is not permitted; anyone considering commercial use is solely
> responsible for legal and regulatory compliance in every applicable jurisdiction.
> See [LICENSE](LICENSE).

**Turn PDFs, decks and Outlook emails into position-aware structured text that LLMs can actually work with.**

Sibling of [pptx-to-ai-text](../pptx-to-ai-text): the same idea generalized — PDF pages, slides and HTML mail bodies are serialized with position and formatting metadata, so an LLM can summarize, restructure or rebuild documents without inventing layout.

> Personal project; no employer code or data. Sample documents are not included — bring your own files to try it.

## Run it

```bash
# single client-side HTML file — nothing to install, nothing leaves your machine
start "文档转AI文本.html"     # or just double-click it / open it in any modern browser
python launcher.py           # optional: serve on localhost instead

node test/run.js             # self-tests (261 assertions; missing sample PDFs are skipped)
python test/make-mht.py      # regenerate the synthetic Outlook .mht fixture
```

Drag a `.pdf`, `.pptx` or `.mht` onto the page; copy the structured text out.
