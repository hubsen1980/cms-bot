global.WebSocket = require('ws')
const Sockette = require('sockette')
const Slimbot = require('slimbot')
const api = require('binance')
const readline = require('readline')

const config = require('./config')
const Trader = require(`./strategies/${config.strategy}`)

readline.emitKeypressEvents(process.stdin)
process.stdin.setRawMode(true)

const telegram = (apikey) => {
    const slimbot = new Slimbot(apikey)
    slimbot.startPolling()
    return slimbot
}

const helpMsg = `
/help : display this list
/pause: pause the trader
/resume: resume trader
/sell: make a limit sell order at the last price
`

const slimbot = config.telegram ? telegram(config.telegramAPI) : null

const client = new api.BinanceRest({
    key: config.API_KEY, // Get this from your account on binance.com
    secret: config.API_SECRET, // Same for this
    timeout: 15000, // Optional, defaults to 15000, is the request time out in milliseconds
    recvWindow: 20000, // Optional, defaults to 5000, increase if you're getting timestamp errors
    disableBeautification: false,
    handleDrift: true
})
const websocket = new api.BinanceWS()

let CACHE = null

slimbot && slimbot.sendMessage(config.telegramUserID, `Trader started`, {
    parse_mode: 'Markdown'
}).catch(console.error)

const cmsWS = new Sockette('wss://market-scanner.herokuapp.com', {
    timeout: 5e3,
    maxAttempts: 10,
    onopen: e => console.log('Connected!'),
    onmessage: e => {
        const data = JSON.parse(e.data)
        if (!data.hasOwnProperty('to')) {
            return
        }
        return startTrader(data)
    },
    onreconnect: e => console.log('Reconnecting...'),
    onmaximum: e => console.log('Stop Attempting!'),
    onclose: e => console.log('Closed!'),
    onerror: e => console.log('Error:')
})

let bot = null
let report = null

function telegramReport(trader) {
    if (!config.telegram || !slimbot) {
        return
    }
    if(!trader) {
        return setTimeout(() => {
            console.log('No Bot yet, retrying in 1s!')
            return telegramReport(bot)
        }, 1000)
    }
    const ID = config.telegramUserID
    console.debug('Reports started!')
    // TELEGRAM_REPORT = true
    slimbot.on('message', msg => {
        const action = msg.text.split()
        switch (true) {
            case action[0] === '/help':
                slimbot.sendMessage(ID, helpMsg, {
                    parse_mode: 'Markdown'
                })
                break
            case trader && action[0] === '/sell':
                slimbot.sendMessage(ID, `Sell message received! Selling ${trader.asset} for ${trader.lastPrice}.`)
                trader.sell({
                    price: trader.lastPrice
                })
                break
            case trader && action[0] === '/pause':
                slimbot.sendMessage(ID, `Stopping trader! To resume write "resume".`)
                trader.stopTrading({
                    cancel: (trader.isBuying || trader.isSelling) ? true : false,
                    userStop: true
                })
                break
            case trader && action[0] === '/resume':
                slimbot.sendMessage(ID, `Resuming trader on ${trader.asset}!`)
                startTrader(null, true)
                break
            default:
                slimbot.sendMessage(ID, `Action not recognized! Type /help for a list of commands.`)
                break
        }
    })

    
    trader.on('tradeStart', () => {
        let msg = `Buying ${trader.asset}.`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('tradeResume', () => {
        let msg = `Resuming ${trader.asset} trade.`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('tradeInfo', () => {
        let pct = (trader.lastPrice / trader.buyPrice) - 1
        pct *= 100
        let msg = `*${trader.product}*
    *${pct < 0 ? 'Down' : 'Up'}:* ${pct.toFixed(2)}%
    *Last Price:* ${trader.lastPrice}
    *Buy Price:* ${trader.buyPrice}
    *Sell Price:* ${trader.sellPrice}
    *Stop Loss:* ${trader.stopLoss}
    *Target Price:* ${trader.targetPrice}`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('tradeInfoStop', () => {
        let msg = `${trader.asset} trade ended!`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('traderCheckOrder', (msg) => {
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('traderPersistenceTrigger', (count) => {
        let msg = `Sell price triggered, persistence activated: ${count}!`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('priceUpdate', (price) => {
        let upPct = (price / trader.buyPrice) - 1
        upPct *= 100
        let msg = `Target price for ${trader.asset} updated: ${price.toFixed(8)}. New target ${upPct.toFixed(2)}%`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('traderSold', (price) => {
        let msg = `Sold ${trader.asset} for ${price}!`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
        // trader = null
    })

    trader.on('filledOrder', (price) => {
        let msg = `Bought ${trader.asset} for ${price}!`
        slimbot.sendMessage(ID, msg, {
            parse_mode: 'Markdown'
        }).catch(console.error)
    })

    trader.on('traderEnded', (restart) => {
        slimbot.sendMessage(ID, `Trader ended`, {
            parse_mode: 'Markdown'
        }).catch(console.error)
        if (!restart) {
            startTrader(CACHE)
        }
    })
}

async function close() {
    console.log('Stopping Trader Bot')
    CACHE = null
    if (bot) {
        await bot.stopTrading({
            cancel: (bot.isBuying || bot.isSelling) ? true : false,
            userStop: true
        })
    }
    await cmsWS.close()
    return process.exit(0)
}

function keypress() {
    return process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') {
            // process.exit()
            close()
        }        
        if (key.ctrl && key.name === 's') {
            if (!bot.isTrading || bot.isBuying || bot.isSelling) {
                console.log('Bot is not trading!')
            } else {
                console.log('Panic selling!!')
                bot.sell()
            }
        } else {
            console.log(`You pressed the "${str}" key`)
        }
    })
}

async function startTrader(data, telegramAction = false) {
    if (bot && bot.isTrading) {
        console.log(`Bot is trading on ${bot.asset}`)
        return
    }
    const regex = RegExp(/(BTC)$/g)

    bot = new Trader({
        test: false,
        client,
        websocket,
        base: config.currency,
        TP: (config.TAKE_PROFIT / 100) + 1,
        TP_p: (config.PARTIAL_TP / 100) + 1,
        SL: (config.STOP_LIMIT / 100) + 1,
        TRAIL: (config.TRAILING_SL / 100) + 1,
        maxBalance: config.MAX_BALANCE
    })

    await bot.isLastTradeOpen()
    if (bot.isResuming) {
        bot.startTrading({
            pair: bot.product,
            time: config.interval
        }).catch(console.error)
        report = telegramReport(bot)
        report
    }
    if (!bot.isResuming && data && data.hasOwnProperty('to') && data.to == 'trader') {
        // console.log(data)
        if (bot && bot.is_trading) {
            console.log(`Bot is trading!`)
            return
        }
        const pair = data.data.sort((a, b) => {
                return b.prob - a.prob
            })
            .filter(p => (regex).test(p.pair))
            .filter(p => p.pair !== bot.lastPair) // don't trade on last pair
        // console.log(pair)
        if (pair.length === 0) {
            console.log(new Date())
            console.log('No pairs to trade!')
            return
        }
        console.log(pair)
        CACHE = pair
        let now = Date.now()
        let diff = new Date(now - data.timestamp).getMinutes()
        if (diff < 15) { //if signal is more than 15 minutes, wait for next 
            let x = null
            for (let i = 0; i < pair.length; i++) {
                if (pair.prob < 0.998) {
                    break
                }
                await bot.startTrading({
                        pair: pair[i].pair,
                        time: config.interval
                    })
                    .then(res => {
                        x = res
                        console.log(pair[i], res)
                    }).catch(console.error)
                if (x) {
                    CACHE.splice(i, 1)
                    break
                }
            }
        report = telegramReport(bot)
        report()
        } else {
            console.log(`Signal is outdated! Sent ${diff} minutes ago!`)
        }
    }
    return
}

// telegramReport(bot)
keypress()

// process.on('exit', async () => {
//     console.log('Stopping Trader Bot')
//     CACHE = null
//     if (bot) {
//         await bot.stopTrading({
//             cancel: (bot.isBuying || bot.isSelling) ? true : false,
//             userStop: true
//         })
//     }
//     await cmsWS.close()
//     process.exit(0)
// })
