# הרצה, גיטהאב ודוקר — הוראות מדויקות

> ## ⚠ שתי אזהרות לפני שמתחילים
>
> **1. אל תעתיק שורה עם `#` והערה בעברית.** ב-zsh (הטרמינל של מק) `#` **אינו** סימן הערה במצב אינטראקטיבי — הוא נשלח כארגומנט לפקודה. כל הפקודות במסמך הזה כתובות **נקיות, בלי הערות בסוף שורה**. תעתיק אותן כמו שהן.
>
> **2. תעתיק שורה אחת בכל פעם**, ותוודא שהיא הצליחה לפני הבאה.

שלושה חלקים נפרדים. **חלק א׳ הוא כל מה שאתה צריך היום.**

---

# חלק א׳ — להריץ על המחשב שלך

## 1. לבדוק את גרסת Node

```bash
node -v
```

צריך **v22.5.0 ומעלה**. כל גרסה חדשה יותר מתאימה — כולל v24 ו-v26.

אם קיבלת `command not found` או מספר נמוך יותר: <https://nodejs.org>, גרסת LTS, להתקין, **לסגור ולפתוח מחדש את iTerm**.

> הפרויקט משתמש ב-SQLite המובנה של Node (`node:sqlite`). **אין שום ספרייה שצריך לקמפל**, ולכן אין צורך בכלי פיתוח של אפל ואין תלות שנשברת עם כל גרסת Node חדשה.

## 2. לפרוס את הזיפ

אם כבר יש לך תיקייה מנסיון קודם, תמחק אותה קודם:

```bash
rm -rf ~/projects/lacanian-agent
```

```bash
mkdir -p ~/projects
```
```bash
cd ~/projects
```
```bash
unzip ~/Downloads/lacanian-agent.zip
```
```bash
cd lacanian-agent
```

לוודא שאתה במקום הנכון:

```bash
pwd
```

צריך להסתיים ב-`/projects/lacanian-agent`.

## 3. להתקין

```bash
npm install
```

לוקח כ-20 שניות. אזהרות צהובות של `npm warn deprecated` הן תקינות.

## 4. ליצור את קובץ ההגדרות

```bash
cp .env.example .env
```

```bash
open -e .env
```

נפתח TextEdit. **תשנה שורה אחת בלבד** — את השורה שמתחילה ב-`LLM_PROVIDER` — כך שתיראה:

```
LLM_PROVIDER=mock
```

Cmd+S לשמור, ולסגור את TextEdit.

`mock` הוא ממלא מקום שלא דורש מפתח ולא עולה כסף. הוא לא אנליטיקאי — הוא נועד רק להראות שהפריים והנעילה עובדים.

## 5. בדיקות

```bash
npm run test:guards
```

צריך להופיע `20 guard tests passed`.

## 6. להריץ

```bash
npm run dev
```

תראה:
```
  listening on http://localhost:3000
  provider: mock
```

**תשאיר את החלון הזה פתוח.** זה השרת.

## 7. בדפדפן

<http://localhost:3000>

תכניס כל כתובת מייל. **הקוד לא נשלח למייל — הוא מודפס בחלון של iTerm.** תחפש שם שורה כמו:

```
[login code] you@example.com -> 481920
```

תעתיק את 6 הספרות לדפדפן.

## 8. פקודות שימושיות

לעצור את השרת — בחלון של iTerm: **Ctrl+C**

למחוק הכל ולהתחיל מאפס:
```bash
rm -rf data
```

## 9. לעבור למודל אמיתי

```bash
open -e .env
```

לשנות שתי שורות:
```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

את המפתח מוציאים מ-<https://console.anthropic.com> → API Keys.

לשמור, לעצור את השרת (Ctrl+C), ולהריץ שוב:

```bash
npm run dev
```

> **המפתח עולה כסף אמיתי.** תגדיר תקרת הוצאה בקונסולה של Anthropic לפני שאתה מתחיל.

מכאן תעבוד לפי `TESTING.md`.

---

# חלק ב׳ — גיטהאב

**מתי צריך:** גיבוי לקוד והיסטוריית שינויים. **לא צריך בשביל להריץ מקומית.**

## הכלל הכי חשוב

**`.env` לעולם לא עולה לגיטהאב.** יש בו את מפתח ה-API. מפתח שעולה לגיטהאב נסרק על ידי בוטים תוך דקות ומנוצל.

`.gitignore` בריפו כבר חוסם אותו, אבל תאמת בעצמך בשלב 3.

## 1. לוודא ש-git קיים

```bash
git --version
```

## 2. לאתחל

```bash
cd ~/projects/lacanian-agent
```
```bash
git init
```
```bash
git add .
```

## 3. לבדוק מה עומד לעלות — אל תדלג

```bash
git status --porcelain | grep -E '\.env$|node_modules|data/|dist/' && echo "STOP - secret file staged" || echo "CLEAN"
```

אם קיבלת `CLEAN` — אפשר להמשיך. אם `STOP` — תעצור ותכתוב לי.

## 4. לשמור

```bash
git config --global user.name "Yaniv"
```
```bash
git config --global user.email "yaniv@revera-ai.com"
```
```bash
git commit -m "Lacanian analytic agent v0.5"
```

## 5. ליצור ריפו ולהעלות

1. <https://github.com/new>
2. שם: `lacanian-agent`
3. **חובה Private.** לא Public.
4. **לא** לסמן "Add a README"
5. Create repository

ואז, עם שם המשתמש שלך במקום `USERNAME`:

```bash
git remote add origin https://github.com/USERNAME/lacanian-agent.git
```
```bash
git branch -M main
```
```bash
git push -u origin main
```

בהעלאה הראשונה יבקשו סיסמה — **זו לא סיסמת החשבון אלא Personal Access Token**. יוצרים ב-Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token, עם הרשאת `repo`.

## 6. מכאן והלאה

```bash
git add .
```
```bash
git commit -m "what changed"
```
```bash
git push
```

---

# חלק ג׳ — דוקר

## מה זה

דוקר אורז את האפליקציה עם כל מה שהיא צריכה לתוך "קופסה" אחת שרצה זהה בכל מקום.

## **אתה לא צריך את זה עכשיו**

לבדיקה על המק שלך `npm run dev` מספיק ועדיף. דוקר נכנס לתמונה רק כשאתה מעלה לשרת באינטרנט. **אם אתה רק בודק — תדלג על החלק הזה לגמרי.**

## כשכן

להוריד **Docker Desktop** מ-<https://www.docker.com/products/docker-desktop>, להתקין, לפתוח ולחכות שהאייקון יראה שהוא רץ.

```bash
cd ~/projects/lacanian-agent
```
```bash
docker build -t lacanian-agent .
```

להריץ:

```bash
docker run --rm -p 3000:3000 -v "$(pwd)/data:/data" -e LLM_PROVIDER=mock lacanian-agent
```

- `-p 3000:3000` מחבר את הפורט של הקופסה למק
- `-v .../data:/data` **קריטי** — כדי שבסיס הנתונים לא יימחק כשהקופסה נסגרת
- `-e` משתני סביבה. בדוקר לא משתמשים בקובץ `.env`

לעצור: Ctrl+C.

## להעלות לאינטרנט (fly.io)

```bash
brew install flyctl
```
```bash
fly auth signup
```
```bash
fly launch --no-deploy
```
```bash
fly volumes create data --size 3
```

הסודות — **לא לגיטהאב ולא לקובץ, ישירות ל-fly:**

**קובץ `.env` לא נטען בפרודקשן, בכלל.** `dotenv/config` קורא `.env` רק אם הוא קיים על הדיסק, ו-fly.io לא מעלה את הקובץ הזה (הוא ברשימת ה-`.gitignore` ואף אחד לא שם אותו בתמונת הדוקר). כל מה שהשרת רואה בפרודקשן זה מה ש-`fly secrets set` שם — שום דבר אחר.

`fly.toml` כבר מגדיר `NODE_ENV=production`, מה שמפעיל בדיקות פתיחה שנכשלות-בבטחה (`assertProductionSafety`): **השרת מסרב לעלות בכלל** אם `ALLOWED_EMAILS` ריק או אם `MAILER` הוא לא `smtp`. זה פיילוט סגור, לא השקה פומבית — אלה לא אזהרות, אלה תנאי סף.

חייבים להיות מוגדרים כ-fly secrets לפני `fly deploy` הראשון:

- `ANTHROPIC_API_KEY` (או `OPENAI_API_KEY` אם `LLM_PROVIDER=openai`) — בלעדיו השרת מסרב לעלות.
- `ALLOWED_EMAILS` — רשימת המשתתפים, מופרדת בפסיקים. חובה בפרודקשן; ריק = השרת מסרב לעלות.
- `MAILER=smtp` **וגם** `SMTP_URL` **וגם** `MAIL_FROM` — חובה בפרודקשן; `MAILER=console` גורם לשרת לסרב לעלות, כי משתתפים לא יכולים לקרוא את הלוגים של השרת.
- `CRISIS_RESOURCES` — מספרי חירום אמיתיים ומאומתים, לפי המדינה שלך. מוצג גם למי שעדיין לא נכנס (מסך ההתחברות וההסכמה).
- `REVIEWER_EMAIL` — לאן הודעת ה-gate (כשה-gate ננעל) נשלחת. בלי זה, הודעת gate לא תישלח לאף אחד — רק תירשם ללוג כשגיאה.
- `PUBLIC_BASE_URL` — למשל `https://lacanian-agent.fly.dev` — כדי שהקישור לתמלול בהודעת ה-gate יהיה קישור אמיתי ולא נתיב יחסי.

```bash
fly secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  ALLOWED_EMAILS="participant1@example.com,participant2@example.com" \
  MAILER="smtp" SMTP_URL="smtps://user:pass@smtp.example.com" MAIL_FROM="no-reply@example.com" \
  CRISIS_RESOURCES="Israel: ERAN 1201 | Emergency 101" \
  REVIEWER_EMAIL="you@example.com" \
  PUBLIC_BASE_URL="https://lacanian-agent.fly.dev" \
  LLM_PROVIDER="anthropic"
```

```bash
fly deploy
```
```bash
fly open
```

> **לפני שמישהו אחר נכנס לכתובת** — הגבלת קצב על בקשות התחברות ועל פניות לסוכן, פקיעת קודי התחברות וטוקנים, ומחיקת חשבון אמיתית כבר ממומשים בקוד (ב1–ב4 בסקירת האבטחה). מה שנשאר: לוודא ש-`CRISIS_RESOURCES` באמת מוגדר לפני שמישהו אמיתי משתמש בזה.

---

# תקלות

| מה קרה | מה לעשות |
|---|---|
| `command not found: node` | Node לא מותקן, או שלא סגרת ופתחת מחדש את iTerm |
| `Cannot find module 'node:sqlite'` | גרסת Node ישנה מ-22.5. תעדכן |
| `ExperimentalWarning: SQLite is an experimental feature` | תקין ולא מזיק. ב-Node 24 ומעלה זה נעלם |
| `sh: tsc: command not found` | `npm install` נכשל. תריץ אותו שוב ותקרא את השגיאה |
| `EADDRINUSE: port 3000` | שרת כבר רץ. `lsof -ti:3000 \| xargs kill` |
| הדף לא נטען | תבדוק שחלון ה-iTerm עם `npm run dev` עדיין פתוח |
| לא מוצא את קוד ההתחברות | הוא ב-iTerm ולא במייל. תחפש `[login code]` |
| `ANTHROPIC_API_KEY is empty` | לא שמרת את `.env`, או שהמפתח ריק |
| `provider_failure` בדפדפן | מפתח שגוי או אין קרדיט. השגיאה המלאה ב-iTerm |
| שינית `.env` ולא קרה כלום | צריך Ctrl+C ואז `npm run dev` מחדש |
| פקודה נכשלה עם טקסט בעברית בשגיאה | העתקת שורה עם `#` והערה. תעתיק רק את הפקודה |
