# 📰 PressReader Coffee Article Scraper

This notebook queries the [PressReader API](https://www.pressreader.com/) for articles related to **coffee**, stores the results in a **SQLite** database, and outputs a Markdown-friendly summary of each article. It's ideal for researchers, librarians, and hobbyists looking to explore coffee-related news and publications.

---

## 🚀 Features

- 🔍 Searches the PressReader API for any keyword (default: `coffee`)
- 🧠 Saves article metadata (title, description, source, date, URL) to a SQLite database
- 🔁 Prevents duplicate entries using article ID
- 📝 Outputs results as readable Markdown
- 🔐 Uses a secure environment variable for your API key

---

## 📄 Example Output

Here’s what the Markdown-formatted article summaries look like:

☕ Coffee and Culture

Publication: Global Coffee Times
Date: 2025-07-28
Description: Exploring how coffee influences social rituals across continents.
URL: Read More
