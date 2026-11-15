// src/help.js — +Help text and per-command help ("+Schedule help").
//
// Replies must never start with '+'.

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
  takegroupid: {
    name: '+TakegroupID',
    short: 'Shows the numeric ID of the group you type it in and saves it for the course.',
    help:
      '*📌 +TakegroupID*\n' +
      'Run it inside a group to get that group’s numeric ID.\n' +
      'The group is also saved as the target for +WebDevCourse.\n' +
      'It only works inside a group.\n\n' +
      '*Usage:*\n```+TakegroupID```',
  },
  webdevcourse: {
    name: '+WebDevCourse',
    short: 'Sends the Web Development course playlist to your course group, video by video.',
    help:
      '*📌 +WebDevCourse*\n' +
      'Sends every video of the playlist (title and link) to the course group, first video to last.\n' +
      'It sends one video about every 8 seconds, and it continues by itself after a restart.\n' +
      'Run it inside the group, or anywhere else to use the group saved by +TakegroupID.\n\n' +
      '*Usage:*\n' +
      '```+WebDevCourse``` start or continue\n' +
      '```+WebDevCourse status``` how many are sent\n' +
      '```+WebDevCourse stop``` pause\n' +
      '```+WebDevCourse restart``` send again from video 1\n\n' +
      '*One-time setup:* the playlist is read with the YouTube Data API.\n' +
      '1. console.cloud.google.com → new project\n' +
      '2. APIs & Services → Library → *YouTube Data API v3* → Enable\n' +
      '3. Credentials → Create credentials → API key\n' +
      '4. Render → Environment → add *YOUTUBE_API_KEY*',
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
  sticker: {
    name: '+Sticker',
    short: 'Turns a photo, video or GIF into a sticker.',
    help:
      '*📌 +Sticker*\n' +
      'Turns a photo, video or GIF into a WhatsApp sticker and sends it in the same chat.\n' +
      'Reply to the photo or video with the command, or send the photo or video with the command as its caption.\n' +
      'Videos and GIFs are cut to the first 6 seconds.\n\n' +
      '*Usage:*\n```+Sticker```',
  },
  image: {
    name: '+Image <prompt>',
    short: 'Generates an AI picture from your description.',
    help:
      '*📌 +Image*\n' +
      'Generates an image from your description (FLUX through Pollinations).\n' +
      'The picture is sent in the chat where you typed the command and can take up to 30 seconds.\n' +
      'Be descriptive for better results.\n\n' +
      '*Usage:*\n```+Image <prompt>```\n\n' +
      '*Examples:*\n```+Image a car flying in the sky```\n```+Image a red desert at sunset, cinematic```',
  },
  summary: {
    name: '+Summary All',
    short: 'Summarizes everything saved so far as key points.',
    help:
      '*📌 +Summary*\n' +
      'Reads all saved messages and sends a summary as bullet points, grouped by person and group.\n' +
      'Urgent items are listed under “Needs attention”.\n' +
      'The saved text is sent to the ChatGPT service to be summarized, so it can take a minute.\n\n' +
      '*Usage:*\n```+Summary All```',
  },
  export: {
    name: '+Export',
    short: 'Sends all saved messages as a text file.',
    help:
      '*📌 +Export*\n' +
      'Sends every saved message as a .txt file, grouped by person and group, oldest first.\n' +
      'Voice notes appear as “[Voice note]” lines, because the audio files are not included.\n' +
      'Times are in Pakistan time (GMT+5).\n\n' +
      '*Usage:*\n```+Export```',
  },
  stats: {
    name: '+Stats',
    short: 'Shows the bot’s numbers: saved messages, top senders, uptime.',
    help:
      '*📌 +Stats*\n' +
      'Shows how many messages are saved (private, groups, by type), calls, and deleted messages.\n' +
      'Also shows your top 5 senders, the busiest hour, voice files stored, and bot uptime and memory.\n' +
      'Everything is counted from what the bot has saved so far.\n\n' +
      '*Usage:*\n```+Stats```',
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
  return COMMANDS[key]?.help || null
}

export function welcomeText() {
  const list = Object.values(COMMANDS)
    .map((c) => `• \`${c.name}\` — ${c.short}`)
    .concat('• `+Help` — Shows this list.')
    .join('\n')
  return (
    `${WELCOME_TITLE}\n` +
    `*Commands Prefix:*            +\n` +
    `*Commands List:*\n${list}\n\n` +
    `For details on any command, add *help* after it. Example: \`+Schedule help\`\n\n` +
    `_In other people’s chats, type commands exactly as written above (for example +ChatGPT) and use -help._`
  )
}
