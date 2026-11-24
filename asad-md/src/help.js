// src/help.js — +Help text and per-command help ("+Schedule help").
//
// Replies must never start with '+'.

import { applyPrefix, getPrefix } from './settings.js'

export const WELCOME_TITLE = '*`👾 Welcome to Asad MD Whatsapp Bot 👾`*'

// key = lowercase command name without '+'
export const COMMANDS = {
  shownow: {
    name: '+ShowNow',
    short: 'Shows your saved chats, calls, voice notes and view-once items.',
    help:
      '*📌 +ShowNow*\n' +
      'Shows everything the bot has saved from your private chats, grouped by person.\n' +
      'Each person gets a number, and messages are grouped by the minute they were sent (Pakistan time).\n' +
      'It also lists calls, voice notes and view-once items, each with its own number.\n\n' +
      '*Usage:*\n```+ShowNow```\n\n' +
      '*Then:*\n' +
      '```+YesVoice1``` sends voice note 1\n' +
      '```+YesView1``` sends view-once item 1',
  },
  yesvoice: {
    name: '+YesVoice<N>',
    short: 'Sends you a saved voice note from the last +ShowNow list.',
    help:
      '*📌 +YesVoice<N>*\n' +
      'Sends you the saved voice note with the number N from your last +ShowNow list.\n' +
      'Send +ShowNow first, because the numbers come from that list.\n' +
      'The list stays valid for 30 minutes; after that, send +ShowNow again.\n\n' +
      '*Usage:*\n```+YesVoice<N>```\n\n' +
      '*Examples:*\n```+YesVoice1```\n```+YesVoice3```',
  },
  yesview: {
    name: '+YesView<N>',
    short: 'Sends you a saved view-once item from the last +ShowNow list.',
    help:
      '*📌 +YesView<N>*\n' +
      'Sends you the saved view-once photo or video with the number N from your last +ShowNow list.\n' +
      'Send +ShowNow first, because the numbers come from that list.\n' +
      'The list stays valid for 30 minutes; after that, send +ShowNow again.\n\n' +
      '*Usage:*\n```+YesView<N>```\n\n' +
      '*Examples:*\n```+YesView1```\n```+YesView2```',
  },
  schedule: {
    name: '+Schedule',
    short: 'Sends a message to any number at the time you choose.',
    help:
      '*📌 +Schedule*\n' +
      'Sends a message to any WhatsApp number at the time you choose, right on time.\n' +
      'Time is Pakistan time (GMT+5). Anything you leave out (AM/PM, day, month, year) is taken from now.\n' +
      'If the time has already passed today, it moves to tomorrow.\n\n' +
      '*Usage:*\n```+Schedule <number> "<message>" [<time>]```\n\n' +
      '*Number:* 0304… or 3048… = Pakistan (+92). Other countries: +<country code><number>\n' +
      '*Message:* inside "quotes"\n' +
      '*Time:* inside [brackets], any date style (3-Nov, 3-11-2026, 3/11/2026, Nov 3, tomorrow)\n\n' +
      '*Timing:* messages are sent a little early so they arrive on the dot. Adjust it with:\n' +
      '```+Schedule early=3000``` sends 3000 ms early\n' +
      '```+Schedule delay=3000``` sends 3000 ms late\n\n' +
      '*Examples:*\n' +
      '```+Schedule 03048648492 "Good morning" [7:30AM]```\n' +
      '```+Schedule +14155550123 "Happy birthday!" [12:00AM 3-Nov]```\n' +
      '```+Schedule 03048648492 "Meeting today" [5:30PM 3/11/2026]```\n\n' +
      '*Related:* +ScheduleList, +Unschedule',
  },
  schedulelist: {
    name: '+ScheduleList',
    short: 'Lists your pending scheduled messages.',
    help:
      '*📌 +ScheduleList*\n' +
      'Shows every scheduled message that has not been sent yet.\n' +
      'Each one shows its number, the receiver, the send time and a preview of the message.\n' +
      'Use the number with +Unschedule if you want to cancel one.\n\n' +
      '*Usage:*\n```+ScheduleList```',
  },
  unschedule: {
    name: '+Unschedule <N>',
    short: 'Cancels a pending scheduled message.',
    help:
      '*📌 +Unschedule*\n' +
      'Cancels a scheduled message so that it is never sent.\n' +
      'N is the schedule number shown when you scheduled it and in +ScheduleList.\n' +
      'Only messages that have not been sent yet can be cancelled.\n\n' +
      '*Usage:*\n```+Unschedule <N>```\n\n' +
      '*Example:*\n```+Unschedule 5```',
  },
  chatgpt: {
    name: '+ChatGPT <question>',
    short: 'Asks ChatGPT and posts the answer in the same chat.',
    help:
      '*📌 +ChatGPT*\n' +
      'Asks the OpenAI GPT model (through Pollinations) your question.\n' +
      'The answer is posted in the chat where you typed the command, marked with 🤖.\n' +
      'It works in your own chat, in other people’s inboxes, and in groups.\n\n' +
      '*Usage:*\n```+ChatGPT <question>```\n\n' +
      '*Examples:*\n```+ChatGPT how to defeat AI```\n```+ChatGPT explain Wi-Fi in 3 lines```',
  },
  chathistory: {
    name: '+ChatHistory [number]',
    short: 'Shows saved messages and voice notes of a person (or everyone in your own chat).',
    help:
      '*📌 +ChatHistory*\n' +
      'Shows every saved text and voice note, oldest first, with voices numbered.\n' +
      'In your own chat it shows everything saved; in someone’s inbox it shows what they sent you.\n' +
      'In a group, add their number. The result is posted in the chat where you typed the command.\n\n' +
      '*Usage:*\n```+ChatHistory```\n```+ChatHistory <number>```\n\n' +
      '*Examples:*\n```+ChatHistory +923048648492```\n```+ChatHistory 03048648492```\n\n' +
      '*Then:* +SendVoice<N> or +SendVoiceAll',
  },
  sendvoice: {
    name: '+SendVoice<N>',
    short: 'Sends a voice note from the last +ChatHistory list.',
    help:
      '*📌 +SendVoice<N>*\n' +
      'Sends the voice note with the number N from your last +ChatHistory result.\n' +
      'Run +ChatHistory first, in the same chat. The list stays valid for 1 hour.\n' +
      'It is sent to the chat where you typed the command.\n\n' +
      '*Usage:*\n```+SendVoice<N>```\n\n' +
      '*Examples:*\n```+SendVoice1```\n```+SendVoice4```',
  },
  sendvoiceall: {
    name: '+SendVoiceAll',
    short: 'Merges all voices from the last +ChatHistory into one audio and sends it.',
    help:
      '*📌 +SendVoiceAll*\n' +
      'Joins every voice note from your last +ChatHistory result into a single audio, oldest first.\n' +
      'Run +ChatHistory first, in the same chat. Up to 100 voices can be merged at once.\n' +
      'It is sent to the chat where you typed the command.\n\n' +
      '*Usage:*\n```+SendVoiceAll```',
  },
  takegroupid: {
    name: '+TakeGroupID',
    short: 'Lists every group you’re in with its numeric group ID.',
    help:
      '*📌 +TakeGroupID*\n' +
      'Lists every group you’re currently a participant of, with each one’s numeric WhatsApp ID.\n' +
      'Only works in your own chat.\n\n' +
      '*Usage:*\n```+TakeGroupID```',
  },
  linkdevice: {
    name: '+LinkDevice <number>',
    short: 'Links someone else\u2019s own WhatsApp as a separate, scoped device.',
    help:
      '*📌 +LinkDevice*\n' +
      'Gives you a pairing code for the given number. THEY must enter it themselves on their own phone ' +
      '(WhatsApp → Linked Devices → Link with phone number) — nothing is linked without their action.\n' +
      'Once linked, they get their own commands (+ShowNow, +SetName, etc.) for their own data only. ' +
      'You never see their messages.\n\n' +
      '*Usage:*\n```+LinkDevice <number>```\n\n' +
      '*Example:*\n```+LinkDevice 03048648492```\n\n' +
      '*Related:* +DelinkDevice, +LinkedDevices',
  },
  delinkdevice: {
    name: '+DelinkDevice <number>',
    short: 'Unlinks a device and erases its saved data to free up server memory.',
    help:
      '*📌 +DelinkDevice*\n' +
      'Logs out and disconnects a linked device, and deletes everything saved for that number.\n' +
      'Use +LinkedDevices first to see which numbers are linked.\n\n' +
      '*Usage:*\n```+DelinkDevice <number>```\n\n' +
      '*Example:*\n```+DelinkDevice 03048648492```',
  },
  linkeddevices: {
    name: '+LinkedDevices',
    short: 'Lists every linked device and how much it has saved.',
    help:
      '*📌 +LinkedDevices*\n' +
      'Shows every currently linked device: its number, name, status, and how many messages and voices it has saved.\n' +
      'Content itself is never shown — only these counts.\n' +
      `The limit is set by the ASADMD_MAX_DEVICES environment variable (default 3).\n\n` +
      '*Usage:*\n```+LinkedDevices```',
  },
  backup: {
    name: '+Backup <number|me>',
    short: 'Makes a one-time download link (zip) with a person’s saved messages and voices.',
    help:
      '*📌 +Backup*\n' +
      'Creates a private download link for a ZIP with everything saved for a linked device: ' +
      'a readable messages.txt, messages.json and all voice notes still on the server.\n' +
      'Send the link to the owner. They open it and tap *Download backup*.\n' +
      'The link expires (30 minutes by default), allows only a few downloads, and cannot be guessed.\n' +
      'Only works in your own chat. Use *+Backup me* for your own archive.\n\n' +
      '*Usage:*\n```+Backup <number>```\n```+Backup me```\n\n' +
      '*Example:*\n```+Backup 03048648492```\n\n' +
      '*Related:* +LinkedDevices',
  },
  changeprefix: {
    name: '+ChangePrefix <symbol>',
    short: 'Changes the symbol your commands start with (default +).',
    help:
      '*📌 +ChangePrefix*\n' +
      'Changes the symbol that starts your commands, in your own chat and in other chats.\n' +
      'Use 1–2 symbols from: ! # $ % & + , - . / : ; = ? ^ |\n' +
      'Letters, digits, spaces and the WhatsApp format characters * _ ~ ` @ are not allowed.\n' +
      'The new prefix is saved and survives restarts. Linked devices keep using +.\n' +
      'If you ever forget it, send *+ResetPrefix* — that one always works.\n\n' +
      '*Usage:*\n```+ChangePrefix <symbol>```\n\n' +
      '*Examples:*\n```+ChangePrefix .```\n```+ChangePrefix !```',
  },
  resetprefix: {
    name: '+ResetPrefix',
    short: 'Puts the command prefix back to + (works even if you forgot the prefix).',
    help:
      '*📌 +ResetPrefix*\n' +
      'Sets the command prefix back to +. This command is always recognised, whatever prefix is active.\n\n' +
      '*Usage:*\n```+ResetPrefix```',
  },
  deleteallchat: {
    name: '+DeleteAllChat',
    short: 'Deletes all saved message records (asks you to confirm).',
    help:
      '*📌 +DeleteAllChat*\n' +
      'Permanently deletes every saved message record from the bot’s database.\n' +
      'Voice files and your WhatsApp login are not touched.\n' +
      'It asks you to confirm first, and the confirmation is valid for 60 seconds.\n\n' +
      '*Usage:*\n```+DeleteAllChat```\nthen\n```+DeleteAllChat confirm```',
  },
  deleteallvoice: {
    name: '+DeleteAllVoice',
    short: 'Deletes all saved voice files (asks you to confirm).',
    help:
      '*📌 +DeleteAllVoice*\n' +
      'Permanently deletes every saved voice note file from the bot’s storage.\n' +
      'Message records stay, and your WhatsApp login is not touched.\n' +
      'It asks you to confirm first, and the confirmation is valid for 60 seconds.\n\n' +
      '*Usage:*\n```+DeleteAllVoice```\nthen\n```+DeleteAllVoice confirm```',
  },
}

export const HELP_TOKENS = new Set(['help', '-help', '--help', '-h', '?'])

// '+yesvoice12' -> 'yesvoice'; '+Schedule' -> 'schedule'
export function commandKey(cmd) {
  return String(cmd).toLowerCase().replace(/^\+/, '').replace(/\d+$/, '')
}

export function helpFor(key) {
  const t = COMMANDS[key]?.help
  return t ? applyPrefix(t) : null
}

export function welcomeText() {
  const list = Object.values(COMMANDS)
    .map((c) => `• \`${c.name}\` — ${c.short}`)
    .concat('• `+Help` — Shows this list.')
    .join('\n')
  return applyPrefix(
    `${WELCOME_TITLE}\n` +
    `*Commands Prefix:*            ${getPrefix()}\n` +
    `*Commands List:*\n${list}\n\n` +
    `For details on any command, add *help* after it. Example: \`+Schedule help\`\n\n` +
    `_In other people’s chats, type commands exactly as written above (for example +ChatGPT) and use -help._`
  )
}
