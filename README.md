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

```
## ☕ Coffee and Culture

**Publication**: Global Coffee Times  
**Date**: 2025-07-28  
**Description**: Exploring how coffee influences social rituals across continents.  
**URL**: [Read More](https://www.pressreader.com/article/12345678)
```

```
## ☕ Sustainable Coffee Farming

**Publication**: Eco Agri News  
**Date**: 2025-07-25  
**Description**: A closer look at regenerative practices in coffee production.  
**URL**: [Read More](https://www.pressreader.com/article/98765432)
```

---

## 📦 Requirements

Install dependencies:

```bash
pip install requests
```

> `sqlite3` is included by default in Python and Colab environments.

---

## 🔐 API Key Setup

This notebook uses the `PRESSREADER_API_KEY` environment variable for security.

### 🔧 In Google Colab:

```python
import os
os.environ['PRESSREADER_API_KEY'] = 'your-api-key-here'
```

### ✅ Or with Colab secrets:

```python
from google.colab import userdata
api_key = userdata.get('PRESSREADER_API_KEY')
```

---

## 📁 Files in This Project

```
pressreader_coffee_search_with_sqlite.ipynb   # Main Colab notebook
README.md                                      # Documentation
```

> ⚠️ The SQLite database file will be created during runtime.

---

## 🧰 How It Works

1. Sends a POST request to the PressReader API.
2. Parses JSON results into structured fields.
3. Saves new articles into `pressreader_coffee_results.db`.
4. Outputs clean Markdown-style summaries.
5. Skips duplicates by checking the `id` field.

---

## ⚠️ Disclaimer

- This project is for educational or research use only.
- Please respect PressReader's terms of service and API usage limits.

---

## ✨ License

[MIT License](LICENSE)

---

**Created by [Paul Clark](https://github.com/your-username)**  
Empowering Libraries, Through Data and Innovation 📚⚙️
