#!/usr/bin/env python3
"""Bündelt index.html + styles.css + app.js + data.js zu einer einzigen,
in sich geschlossenen Datei dist/Montageplanung.html (analog zum
Termineinladungs-Generator: eine Datei, überall lauffähig / online ablegbar).
"""
import os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
os.makedirs(DIST, exist_ok=True)

def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()

html = read("index.html")
css = read("styles.css")
data_js = read("data.js")
cloud_js = read("cloud.js")
app_js = read("app.js")

# <link rel="stylesheet" href="styles.css?v=..."> -> <style>…</style>
html = re.sub(
    r'<link[^>]*href="styles\.css(?:\?[^"]*)?"[^>]*>',
    lambda m: "<style>\n" + css + "\n</style>",
    html,
)
# <script src="xxx.js?v=..."></script> -> inline (Query-String tolerant)
def inline_script(js):
    return lambda m: "<script>\n" + js + "\n</script>"

for name, js in (("data", data_js), ("cloud", cloud_js), ("app", app_js)):
    html = re.sub(
        r'<script src="' + name + r'\.js(?:\?[^"]*)?"></script>',
        inline_script(js),
        html,
    )

out = os.path.join(DIST, "Montageplanung.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)

# Kurzer Selbsttest: keine externen Datei-Referenzen mehr übrig
leftovers = re.findall(r'(?:href|src)="(?!https?:|data:|#)([^"]+\.(?:css|js))"', html)
size_kb = os.path.getsize(out) / 1024
print(f"OK  -> {out}  ({size_kb:.0f} KB)")
if leftovers:
    print("WARNUNG: externe Referenzen übrig:", leftovers)
else:
    print("Selbsttest: keine externen CSS/JS-Referenzen – Datei ist eigenständig.")
