const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Учетные данные партнера
const PARTNER_EMAIL = process.env.PARTNER_EMAIL || 'ВАШ_EMAIL_ОТ_ПОРТАЛА';
const PARTNER_PASSWORD = process.env.PARTNER_PASSWORD || 'ВАШ_ПАРОЛЬ_ОТ_ПОРТАЛА';

app.post('/api/get-price', async (req, res) => {
  const { charter_date, charter_time, hours, guests } = req.body;

  if (!charter_date || !charter_time || !hours || !guests) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  let browser;
  try {
    // Запускаем невидимый браузер Chromium
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Настраиваем размер экрана и यूजर-агент, как у обычного человека
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 1. Переходим на страницу логина
    await page.goto('https://partners.xclusiveyachts.com/login/', { waitUntil: 'networkidle2' });

    // 2. Вводим логин и пароль в поля по их точным ID из HTML
    await page.type('#login_form_username', PARTNER_EMAIL);
    await page.type('#login_form_password', PARTNER_PASSWORD);

    // 3. Кликаем на кнопку входа и ждем, пока страница перезагрузится
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    // 4. Теперь, когда браузер авторизован, выполняем fetch прямо внутри контекста этой страницы
    const priceData = await page.evaluate(async (date, time, hrs, gst) => {
      const response = await fetch("https://partners.xclusiveyachts.com/private-charter/availability/", {
        method: "POST",
        headers: {
          "accept": "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest"
        },
        body: `charter_date=${date}&charter_time=${encodeURIComponent(time)}&hours=${hrs}&guests=${gst}`
      });
      return response.json();
    }, charter_date, charter_time, hours, guests);

    // Возвращаем чистый JSON клиенту (в Bubble)
    res.json(priceData);

  } catch (error) {
    console.error('Puppeteer Proxy Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch price data', details: error.message });
  } finally {
    if (browser) {
      await browser.close(); // Всегда закрываем браузер, чтобы не тратить память
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
