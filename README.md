# HOLO Hold'em

可線上連線的德州撲克。一人開房、其他人用瀏覽器打開連結就能同桌，手機和電腦都能玩，不用安裝。

## 開始玩

需要 [Node.js](https://nodejs.org) 20 以上。

**跟不同網路的朋友玩（Windows）**：雙擊 `start.bat`。

其他系統，或想用指令啟動：

```bash
npm install
npm run share
```

它會啟動遊戲伺服器，並開一條 Cloudflare 免費臨時通道，然後印出一個 `https://xxxx.trycloudflare.com` 網址、自動打開瀏覽器。進去開房後按「複製邀請連結」，把連結傳給朋友。

- 第一次執行會從 Cloudflare 官方 GitHub 下載 `cloudflared`（約 40 MB）到專案的 `.tools/`。
- 這個網址每次啟動都會變，視窗關掉遊戲就結束。
- 開房的電腦要保持開機與連網。

**只在同一個 Wi-Fi 內玩**：

```bash
npm start
```

終端機會印出區域網路網址（例如 `http://192.168.1.20:3000`）。Windows 第一次會跳防火牆提示，要允許「私人網路」朋友才連得進來。

### 想要固定網址

把專案部署到支援 WebSocket 的 Node.js 主機（Render、Railway、Fly.io、自己的 VPS）即可，啟動指令是 `npm start`。伺服器會讀取環境變數 `PORT`、`HOST`。

## 操作

| 按鍵 | 動作 |
|---|---|
| `F` | 棄牌（可以免費過牌時不會觸發，避免誤按） |
| `C` | 過牌 / 跟注 |
| `R` | 用目前滑桿的金額下注 / 加注 |

沒輪到你時可以先選「過牌 / 棄牌」或「跟任何注」，輪到時自動執行。

## 規則處理

- 標準無限注德州撲克，2 到 9 人；單挑時莊家是小盲。
- 主池與多層邊池、未被跟注的多餘下注退回、平分底池的零頭給莊家左手邊第一位贏家。
- 不足額全下不會重開已行動玩家的加注權，累積達完整加注才會。
- 全下且不會再有下注時，提前公開雙方底牌再發完公共牌。
- 超時自動過牌或棄牌；連續超時兩次會被設為離座，按「回到牌桌」回來。
- 斷線或重新整理後自動接回原座位；斷線期間輪到你只會等 10 秒。

## 安全性

發牌與判定都在伺服器，用 `crypto.randomInt` 洗牌。其他人的底牌在該公開之前不會送到你的瀏覽器，所以看原始碼或封包也看不到。

通道網址是公開的，任何拿到網址的人都能開房或用房號加入，但沒有帳號、也不碰真實金錢。這是給朋友玩的遊戲籌碼，不要用於賭博。

## 開發

```bash
npm test
```

```
server/evaluator.js   牌型判定
server/game.js        規則引擎（不碰網路與計時器）
server/room.js        房間、成員、計時與節奏
server/index.js       HTTP 與 WebSocket 伺服器
scripts/share.js      對外通道
public/               前端，沒有建置步驟
test/                 規則、牌型與真實 WebSocket 連線測試
```

字型 Chakra Petch 與 JetBrains Mono 採用 SIL Open Font License。
