#!/usr/bin/env bash
set -e

echo "🚀 [GitHub Pages] Налаштування та публікація верифікатора коду..."
echo "📍 Репозиторій: grizlizora/cheapestinference-bot"
echo "🌐 URL верифікатора: https://grizlizora.github.io/cheapestinference-bot/"

if [ ! -d "docs" ] || [ ! -f "docs/index.html" ]; then
  echo "❌ Помилка: директорія docs/ або docs/index.html не знайдена!"
  exit 1
fi

git add docs/ .github/workflows/deploy-pages.yml
if git diff-index --quiet HEAD --; then
  echo "✅ Файли docs/ та workflow вже зафіксовані в git."
else
  git commit -m "feat: deploy Zero-Trust Code Verifier to GitHub Pages"
  echo "✅ Створено коміт для деплою GitHub Pages."
fi

echo "🚀 Для відправки змін у GitHub виконайте: git push origin main"
