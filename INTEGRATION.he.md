# חיבור מודול השרת (Likes Quota) לפרויקט ExtSync

מודול הסנכרון נוסף **כמודול נוסף בתוך ה-API הקיים** של ExtSync
(`apps/api`, שהוא FastAPI + Postgres + SQLAlchemy + Alembic). לא שונתה שום
התנהגות קיימת; נוספו קבצים חדשים והמודול נרשם דרך מנגנון ה-routers הקיים.

## קבצים שנוספו / שונו בצד השרת

נתיב הבסיס: `apps/api/`

נוספו:
- `src/extsync_api/models/likes_quota.py` - מודלים `LikesQuotaDaily`, `LikesQuotaEvent`.
- `src/extsync_api/schemas/likes_quota.py` - סכמות Pydantic (camelCase).
- `src/extsync_api/services/likes_quota_service.py` - כל הלוגיקה העסקית והכללים.
- `src/extsync_api/routers/likes_quota.py` - ה-router וה-endpoints + שכבת auth.
- `alembic/versions/c1d2e3f4a5b6_add_likes_quota.py` - מיגרציית הטבלאות.
- `tests/test_likes_quota.py` - בדיקות end-to-end (10 בדיקות, עוברות).

שונו (תוספות בלבד, ללא שינוי התנהגות קיימת):
- `src/extsync_api/main.py` - הוספת `"likes_quota"` לרשימת ה-routers האופציונליים.
- `src/extsync_api/models/__init__.py` - ייבוא המודלים החדשים (לאכלוס `Base.metadata`).
- `src/extsync_api/config.py` - הגדרות חדשות (ראו למטה).
- `src/extsync_api/errors.py` - קודי שגיאה `DUPLICATE_EVENT`, `LIMIT_REACHED`.
- `pyproject.toml` - הוספת `tzdata` (מסד הזמנים של Asia/Jerusalem).

## הרצת המיגרציה

```bash
cd apps/api
alembic upgrade head     # יוצר likes_quota_daily ו-likes_quota_events
```

`down_revision` של המיגרציה הוא ה-head הקודם (`a1b2c3d4e5f6`), כך שהיא נכנסת
בסוף השרשרת בלי התנגשות.

## פריסה (VPS)
לפי `CLAUDE.md` של ExtSync, ה-API נפרס ידנית ב-VPS. הצעדים:
1. למשוך את הקוד.
2. `pip install -e .` (כדי לקבל את `tzdata`) או `pip install tzdata`.
3. `alembic upgrade head`.
4. הפעלה מחדש של שירות ה-API.

## הגדרות חדשות (config / env)

| Env | ברירת מחדל | תיאור |
|-----|------------|-------|
| `LIKES_QUOTA_DAILY_LIMIT` | `20` | מגבלת לייקים יומית. |
| `LIKES_QUOTA_PER_USER_LIMIT` | `6` | מגבלת לייקים למשתמש יחיד. |
| `LIKES_QUOTA_TIMEZONE` | `Asia/Jerusalem` | אזור הזמן לחישוב "היום" והאיפוס היומי. |
| `LIKES_QUOTA_DEV_AUTH` | `false` | **DEV ONLY.** מאפשר זיהוי דרך הכותרת `X-Dev-Quota-User` במקום טוקן אמיתי. חסום אוטומטית כש-`ENVIRONMENT=production`. |

---

## מודל ההזדהות (Auth) - חשוב

המודול **משתמש ב-auth הקיים של ExtSync**: כל בקשה צריכה כותרת
`Authorization: Bearer <token>`, כאשר הטוקן הוא או JWT של session, או API token
(`tok_...`). הזיהוי מתבצע דרך ה-dependency הקיים `get_optional_user`.

**המכסה מקושרת למשתמש המאומת (`user.id`), לא ל-`forumUserId` שמגיע מהלקוח.**
זהות הפורום (uid/username/userslug) נשמרת כ-metadata לתצוגה בלבד. המשמעות:
- לקוח יכול לקרוא/לשנות **רק** את המכסה של עצמו.
- אי אפשר "לזייף" ספירה של משתמש אחר על-ידי שליחת uid אחר.

### איך התוסף משיג טוקן?
זהו נקודת החיבור ל-auth הקיים שלך. שתי אפשרויות:
1. **API token** - יוצרים טוקן דרך ה-endpoint הקיים `POST /api-tokens`, ומדביקים
   אותו בתוסף תחת *הגדרות מתקדמות ← טוקן הזדהות*. (פשוט ויציב לשימוש אישי.)
2. **session JWT** - אם בעתיד תרצה זרימת התחברות מובנית בתוסף, אפשר להזריק את
   ה-access token של ExtSync לאותו שדה. הקוד כבר מוכן לכך - הוא פשוט שולח את מה
   ששמור תחת `MTLQ_AUTH_TOKEN`.

> **סנכרון בין מחשבים** עובד כאשר אותו טוקן/חשבון ExtSync מוגדר בשני המחשבים.

### DEV ONLY fallback
לפיתוח מקומי בלי התחברות: מגדירים `LIKES_QUOTA_DEV_AUTH=true` (רק כש-
`ENVIRONMENT != production`), ובתוסף תחת *משתמש פיתוח* מזינים מזהה כלשהו. השרת
יזהה אותו כ-`dev:<value>`. **בפרודקשן ה-fallback חסום לחלוטין** ע"י הבדיקה
`not settings.is_production`.

---

## חוזה ה-API

בסיס: `<API_BASE_URL>/api/likes-quota`. כל הבקשות דורשות `Authorization` (או
ה-DEV header). כל התשובות ב-JSON, camelCase.

### `GET /today`
פרמטרי query אופציונליים (metadata): `forumUserId`, `username`, `userslug`.

תשובה (200):
```json
{
  "ok": true,
  "date": "2026-06-16",
  "likesToday": 13,
  "dailyLimit": 20,
  "perUserLimit": 6,
  "targetUsers": { "502": { "username": "YAHBDK", "count": 4 } },
  "updatedAt": "2026-06-16T12:40:00.000Z"
}
```
> `GET` לא יוצר שורה ב-DB; אם אין עדיין נתון להיום, מוחזר מצב ריק (0/20). כך
> ה-polling כל 15 שניות לא מייצר עומס כתיבה, והיום עדיין "מתאפס" לפי התאריך.

### `POST /increment`  ו-  `POST /decrement`
גוף:
```json
{
  "postId": "12345",
  "topicId": "678",
  "targetUserId": "502",
  "targetUsername": "YAHBDK",
  "clientEventId": "uuid-...",
  "createdAt": "2026-06-16T12:40:00.000Z",
  "forumUser": { "forumUserId": "...", "username": "...", "userslug": "..." }
}
```
מחזיר את אותו מבנה כמו `/today` (המצב המעודכן).

כללי מניעת כפילויות (idempotency):
- אותו `clientEventId` שכבר עובד ← מוחזר המצב הנוכחי, **ללא ספירה כפולה**.
- `increment` על `postId` שכבר "לויק" היום ← no-op (לא נספר פעמיים).
- `decrement` על `postId` שלא נספר ← no-op.
- `decrement` מסיר את הפוסט מהספירה ומעדכן את מונה ה-`targetUsers`.

### `POST /set`
גוף: `{ "likesToday": 20, "reason": "manual-popup" }` (טווח חוקי 0..`dailyLimit`).
מסמן `manualOverride=true`. ערך מחוץ לטווח ← `422 VALIDATION_ERROR`.

### `POST /reset`
גוף: `{ "reason": "manual-reset" }`. מאפס `likesToday=0` ומרוקן את `targetUsers`.

### מבנה שגיאה אחיד
```json
{ "error": { "code": "UNAUTHORIZED", "message": "...", "details": {} } }
```
קודים רלוונטיים: `UNAUTHORIZED`, `VALIDATION_ERROR`, `DUPLICATE_EVENT`,
`LIMIT_REACHED`, `INTERNAL`.

---

## בדיקות צד שרת
```bash
cd apps/api
python -m pytest tests/test_likes_quota.py -q
```
מכסות: התחלה ריקה, increment, מניעת כפילות לפי clientEventId, dedup לפי postId,
decrement, ולידציה של set, reset, בידוד בין משתמשים, ודרישת auth (401).
