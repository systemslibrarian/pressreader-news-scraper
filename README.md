# 📰 PressReader API to SQLite (Coffee Article Collector)

This notebook queries the [PressReader API](https://www.pressreader.com/) for articles related to **coffee**, stores the results in a **SQLite** database, and outputs a Markdown-friendly summary of each article.  
It's ideal for researchers, librarians, and hobbyists looking to explore coffee-related news and publications.

---

## 🚀 Features

- 🔍 Searches the PressReader API for any keyword (default: `coffee`)
- 🧠 Saves article metadata (title, description, source, date, URL) to a SQLite database
- 🔁 Prevents duplicate entries using article ID as a primary key
- 📝 Outputs results as readable Markdown
- 🔐 Uses a secure environment variable for your API key

---

## 📄 Example Output

Here’s what the Markdown-formatted article summaries look like:

<pre>
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
</pre>

---


## 📦 Requirements

Install the required dependencies:

```bash
pip install requests

Note: `sqlite3` is included by default in Python and Colab environments.

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
userdata.set_secret('PRESSREADER_API_KEY')
```

---

## 📁 Files in This Project

pressreader_api_to_sqlite.ipynb    # Main Colab notebook
README.md                          # Project documentation
⚠️ The SQLite database file (`pressreader_coffee_results.db`) will be created during runtime.

---

## 🧰 How It Works

1. Sends a POST request to the PressReader Discovery API with a keyword (e.g. "coffee").
2. Parses the JSON results into article metadata: ID, title, description, publication name, date, and URL.
3. Stores each article in a local SQLite database (pressreader_coffee_results.db).
4. Skips duplicates using the article ID as a primary key.
5. Displays Markdown summaries of the most recent articles.

---
## 📁 Files in This Project
pressreader_api_to_sqlite.ipynb    # Main Colab notebook
README.md                          # Project documentation
⚠️ The SQLite database file (pressreader_coffee_results.db) is created at runtime.
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
