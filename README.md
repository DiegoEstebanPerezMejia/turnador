# Turnero Web

Versión web del sistema de turnos (antes en PyQt5). Hecha con **Flask**, base de datos **Neon (PostgreSQL)** y lista para desplegar en **Render**.

El estado (turnos, ajustes, credenciales, historial) vive en la base de datos, así que varias computadoras o pantallas ven lo mismo. La página se sincroniza sola cada 2 segundos.

## Estructura

```
turnero-web/
├── app.py              # Flask: rutas, API y lógica del turnero
├── models.py           # Tablas (SQLAlchemy)
├── templates/index.html
├── static/css/style.css
├── static/js/app.js
├── requirements.txt
├── render.yaml         # Blueprint de Render
├── .env.example
└── .gitignore
```

## Despliegue paso a paso

### 1. Base de datos en Neon
1. Crea un proyecto en [neon.tech](https://neon.tech).
2. En **Connect**, activa **Connection pooling** y copia la cadena (`postgresql://...-pooler...?sslmode=require`).
3. No hace falta crear tablas: la app las crea al arrancar.

### 2. Repositorio en GitHub
```bash
cd turnero-web
git init
git add .
git commit -m "Turnero web"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/turnero-web.git
git push -u origin main
```

### 3. Servicio en Render
**Opción A (Blueprint):** en Render, *New → Blueprint*, elige el repositorio y rellena cuando lo pida:
- `DATABASE_URL`: la cadena de Neon
- `ADMIN_PASSWORD` y `SUB_ADMIN_PASSWORD`: las claves iniciales

**Opción B (manual):** *New → Web Service* con estos valores:
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app --workers 1 --threads 4 --timeout 60 --bind 0.0.0.0:$PORT`
- Variables de entorno: `PYTHON_VERSION=3.12.7`, `DATABASE_URL`, `ADMIN_PASSWORD`, `SUB_ADMIN_PASSWORD`, `APP_TIMEZONE=America/Mexico_City`

## Variables de entorno

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión de Neon. Vacía = SQLite local |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Administrador inicial (por defecto `admin` / `admin123`) |
| `SUB_ADMIN_USER` / `SUB_ADMIN_PASSWORD` | Sub-administrador inicial (por defecto `sub_admin` / `sub123`) |
| `APP_TIMEZONE` | Zona horaria de fechas y horas (por defecto `America/Mexico_City`) |

Las credenciales iniciales solo se usan cuando la base está vacía; después se guardan cifradas (hash) en la BD y se cambian desde **🔑 Cambiar Clave**. **Cambia las claves por defecto antes de publicar.**

## Uso local
```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # opcional
python app.py                    # http://localhost:5000
```

## Funciones
- Panel de **espera** y de **atención** con turno y empleado en grande.
- Empleado obligatorio u opcional, y cotización automática de 6 dígitos (solo administrador cambia estos modos).
- Regla de paridad al limpiar y al reiniciar, igual que la versión de escritorio.
- Roles: **admin** (todo) y **sub_admin** (reiniciar turnos y cerrar sesión).
- Historial y resumen de sesiones, con tiempos de atención por turno.
- **🖥️ Modo Pantalla** (`/?modo=pantalla`): solo los paneles, para un monitor o TV; doble clic para pantalla completa.

### Atajos de teclado
Los navegadores reservan `Ctrl+N`, `Ctrl+L`, etc., así que se usan combinaciones con **Alt**:

| Atajo | Acción |
|---|---|
| `Alt+N` | Nuevo turno |
| `Alt+S` | Siguiente |
| `Alt+A` o `Retroceso` | Devolver turno a espera |
| `Alt+L` | Limpiar espera |
| `Alt+K` | Limpiar atención |
| `Alt+C` | Registrar cotización |

## Diferencias con la versión de escritorio
- **Cerrar ventana → 🏁 Cerrar Sesión**: guarda el resumen en el historial y empieza una sesión nueva (pide credenciales de admin o sub_admin).
- **Limpiar atención** conserva las estadísticas de esos turnos (en escritorio se borraban).
- El número de empleado sugerido se guarda por navegador.
- Contraseña mínima de 6 caracteres y bloqueo temporal tras 5 intentos fallidos.
- Las operaciones diarias (nuevo turno, siguiente, etc.) no piden login, como en la app original; mantén privada la URL.

## Notas del plan gratuito
- Render gratis duerme el servicio tras un rato sin visitas; la primera carga puede tardar ~1 minuto.
- Neon suspende la base sin uso y se reactiva sola. Si ves un error de conexión por `channel_binding`, quita ese parámetro de la cadena.
