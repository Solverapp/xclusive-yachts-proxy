const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Учетные данные партнера
const PARTNER_EMAIL = process.env.PARTNER_EMAIL || 'ВАШ_EMAIL_ОТ_ПОРТАЛА';
const PARTNER_PASSWORD = process.env.PARTNER_PASSWORD || 'ВАШ_ПАРОЛЬ_ОТ_ПОРТАЛА';

// Глобальный кэш сессии
let cachedCookies = null;
let browserInstance = null;

// Функция авторизации
async function refreshSession() {
  console.log('Инициализация новой сессии Puppeteer...');
  
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  const page = await browserInstance.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ТВОЙ URL: Переходим на страницу логина поддомена partners
    await page.goto('https://partners.xclusiveyachts.com/login/', { waitUntil: 'networkidle2' });
    
    // Вводим логин и пароль
    await page.type('#login_form_username', PARTNER_EMAIL);
    await page.type('#login_form_password', PARTNER_PASSWORD);

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    // Сохраняем куки
    cachedCookies = await page.cookies();
    console.log('Сессия успешно сохранена в кэш сервера!');
  } finally {
    await page.close();
  }
}

app.post('/api/get-price', async (req, res) => {
  const { charter_date, charter_time, hours, guests } = req.body;

  if (!charter_date || !charter_time || !hours || !guests) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Если сессии нет - создаем
  if (!cachedCookies) {
    try {
      await refreshSession();
    } catch (err) {
      return res.status(500).json({ error: 'Authentication failed', details: err.message });
    }
  }

  let page;
  try {
    page = await browserInstance.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Накатываем куки
    await page.setCookie(...cachedCookies);

    // ТВОЙ URL: Переходим на домен партнеров перед fetch, чтобы избежать CORS ошибки
    await page.goto('https://partners.xclusiveyachts.com', { waitUntil: 'domcontentloaded' });

    // Делаем мгновенный fetch в контексте домена партнеров
    let rawPriceData = await page.evaluate(async (date, time, hrs, gst) => {
      try {
        // ТВОЙ URL: точный эндпоинт для запроса цен
        const response = await fetch("https://partners.xclusiveyachts.com/private-charter/availability/", {
          method: "POST",
          headers: {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest"
          },
          body: `charter_date=${date}&charter_time=${encodeURIComponent(time)}&hours=${hrs}&guests=${gst}`
        });
        return await response.json();
      } catch (e) {
        return { success: false, error_internal: e.message };
      }
    }, charter_date, charter_time, hours, guests);

    // Если куки протухли во время ожидания, обновляем сессию и повторяем один раз
    if (!rawPriceData || rawPriceData.success === false || rawPriceData.error_internal) {
      console.log('Сессия устарела или произошел сбой, обновляем куки...');
      await refreshSession();
      await page.setCookie(...cachedCookies);
      await page.goto('https://partners.xclusiveyachts.com', { waitUntil: 'domcontentloaded' });
      
      rawPriceData = await page.evaluate(async (date, time, hrs, gst) => {
        try {
          const response = await fetch("https://partners.xclusiveyachts.com/private-charter/availability/", {
            method: "POST",
            headers: {
              "accept": "application/json, text/javascript, */*; q=0.01",
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
              "x-requested-with": "XMLHttpRequest"
            },
            body: `charter_date=${date}&charter_time=${encodeURIComponent(time)}&hours=${hrs}&guests=${gst}`
          });
          return await response.json();
        } catch (e) {
          return { success: false, error_internal: e.message };
        }
      }, charter_date, charter_time, hours, guests);
    }

    // Формируем плоский массив ответа для Bubble
    const formattedResponse = {
      success: true,
      count: (rawPriceData && rawPriceData.available) ? Object.keys(rawPriceData.available).length : 0,
      selected_date: charter_date,
      selected_time: charter_time,
      searched_at: new Date().toISOString(),
      available: []
    };

    if (rawPriceData && rawPriceData.available && typeof rawPriceData.available === 'object') {
      Object.keys(rawPriceData.available).forEach(yachtId => {
        const yachtDetails = rawPriceData.available[yachtId];
        if (yachtDetails && typeof yachtDetails === 'object') {
          formattedResponse.available.push({
            id: yachtId.toString(),
            net_amount: yachtDetails.net_amount || 0,
            net_formatted: yachtDetails.net_formatted || `AED ${yachtDetails.net_amount}`
          });
        }
      });
    }

    res.json(formattedResponse);

  } catch (error) {
    console.error('Proxy Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch price data', details: error.message });
  } finally {
    if (page) {
      await page.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
