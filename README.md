# PressReader News Search (Coffee Example)

This Colab notebook demonstrates how to query the [PressReader API](https://www.pressreader.com/) for articles on a given topic (e.g., "coffee"), store the results in a local SQLite database, and display them in a structured format.

## Features

- 🔎 Search PressReader API with JSON payload
- 🗃️ Store article metadata in SQLite
- 📋 Display results in readable Markdown-style output
- 🧱 Built with: Python, requests, sqlite3

## Usage

1. Clone the repo or open the notebook in Colab.
2. Set your API key via `os.environ['PRESSREADER_API_KEY']` or hardcode it (not recommended).
3. Run the notebook and explore the stored articles.

## Example Query

```json
{
  "query": "coffee"
}
