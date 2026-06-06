# Project Global Conflict — восстановленный проект

Папка восстановлена после удаления из:

- установленного лаунчера 2.1.0 (`app.asar` + extraResources)
- GitHub `Vopol4ik/globalwar-updates` (манифест модпака)
- GitHub Release `content.7z`

## Структура

| Папка | Назначение |
|--------|------------|
| `launcher/` | Electron-лаунчер (исходники 2.1.0) |
| `github-updates/` | Манифест обновлений (git) |
| `svo-build/` | Базовый config/options для клиента |
| `mod/build/libs/` | Собранный jar `pgcclient-2.1.0.jar` (без Java-исходников) |

## Запуск из исходников

```powershell
cd launcher
npm install
npm start
```

## Сборка установщика на рабочий стол

```powershell
cd launcher
npm run dist:desktop
```

## Что не восстановилось

- **Исходники мода Forge** (Java) — только готовый `.jar` из `content.7z`
- **Полная папка svo-build** с mods/shaderpacks/tacz — только config из установщика
- **Старый git-история** корневого проекта (если не было remote)

Подробности: `RECOVERY_REPORT.txt`
