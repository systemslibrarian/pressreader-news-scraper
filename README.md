# 📰 PressReader API to SQLite  
**Demo Project: Coffee Article Collector**

> 🔑 **Note:** You must set your own API key before running this notebook.

[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/systemslibrarian/pressreader-news-scraper/blob/main/pressreader_api_to_sqlite.ipynb)

This notebook demonstrates how to query the [PressReader API](https://www.pressreader.com/) and store results in a **SQLite** database.  
It uses **coffee** as a sample keyword but can be adapted for any topic or term.  

It’s ideal for **researchers, librarians, and hobbyists** looking to explore topic-based news and publications.

---

## 🚀 Features
- 🔍 Search the PressReader API for any keyword (default: `coffee`)
- 🧠 Save article metadata (title, description, source, date, URL) to SQLite
- 🔁 Prevent duplicate entries using article ID as the primary key
- 📝 Output results in easy-to-read Markdown format
- 🔐 Secure API key handling via environment variable

---

## 📦 Requirements

Install required dependencies:
```bash
pip install requests pandas python-dotenv
```
> `sqlite3` is built into Python, so no extra install is needed.

---

## 🔐 API Key Setup

This notebook uses the `PRESSREADER_API_KEY` environment variable.

**In Google Colab**:
```python
import os
os.environ['PRESSREADER_API_KEY'] = 'your-api-key-here'
```

**Or using Colab Secrets**:
```python
from google.colab import userdata  
userdata.set_secret('PRESSREADER_API_KEY')
```

---

## ▶️ How to Run

1. **Open in Colab** → Click the badge at the top of this README.
2. **Install dependencies** → Run the first cell.
3. **Set your API key** → Add it via environment variable or Colab secrets.
4. **Run all cells** → Fetch results, save to SQLite, and display Markdown summaries.

---

## 📄 Example Output

```markdown
## ☕ Coffee and Culture  
**Publication**: Global Coffee Times  
**Date**: 2025-07-28  
**Description**: Exploring how coffee influences social rituals across continents.  
**URL**: [Read More](https://www.pressreader.com/article/12345678)

## ☕ Sustainable Coffee Farming  
**Publication**: Eco Agri News  
**Date**: 2025-07-25  
**Description**: A closer look at regenerative practices in coffee production.  
**URL**: [Read More](https://www.pressreader.com/article/98765432)
```

---

## 📂 Project Files
- `pressreader_api_to_sqlite.ipynb` → Main Colab notebook  
- `README.md` → Project documentation  
- `pressreader_coffee_results.db` → Created at runtime (not stored in repo)  

---

## 🧰 How It Works
1. Sends a POST request to the PressReader Discovery API.
2. Parses JSON results into structured article metadata.
3. Saves each entry in a SQLite DB, skipping duplicates.
4. Displays formatted Markdown summaries of the most recent articles.

---

## 🛠 Troubleshooting
- **Invalid API Key** → Double-check `PRESSREADER_API_KEY` value.  
- **Empty Results** → Adjust your search keyword/date range.  
- **Rate Limits** → Wait and retry after a few minutes.

---

## ⚠️ Disclaimer
- For educational/research purposes only.  
- Respect PressReader’s terms of service and API limits.

---

## ✨ License
[MIT License](LICENSE)

---

**Created by [Paul Clark](https://github.com/systemslibrarian)**  
Empowering Libraries Through Data and Innovation 📚⚙️
