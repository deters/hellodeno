import yargs from "https://deno.land/x/yargs/deno.ts"

import * as Mustache from "https://deno.land/x/mustache/mod.ts"
import moment from "npm:moment-timezone"
//import * as ical2json from "npm:ical2json"
import * as path from "https://deno.land/std/path/mod.ts"

// Make sure lines are splited correctly
// http://stackoverflow.com/questions/1155678/javascript-string-newline-character
const NEW_LINE = /\r\n|\n|\r/
const COLON = ":"
// const COMMA = ",";
// const DQUOTE = "\"";
// const SEMICOLON = ";";
const SPACE = " "

export interface IcalObject {
  [key: string]: string | string[] | IcalObject[]
}

/**
 * Take ical string data and convert to JSON
 */
function convert(source: string): IcalObject {
  const output: IcalObject = {}
  const lines = source.split(NEW_LINE)

  let parentObj: IcalObject = {}
  let currentObj: IcalObject = output
  const parents: IcalObject[] = []

  let currentKey = ""

  for (let i = 0; i < lines.length; i++) {
    let currentValue = ""

    const line = lines[i]
    if (line.charAt(0) === SPACE) {
      currentObj[currentKey] += line.substr(1)
    } else {
      const splitAt = line.indexOf(COLON)

      if (splitAt < 0) {
        continue
      }

      currentKey = line.substr(0, splitAt)
      currentValue = line.substr(splitAt + 1)

      switch (currentKey) {
        case "BEGIN":
          parents.push(parentObj)
          parentObj = currentObj
          if (parentObj[currentValue] == null) {
            parentObj[currentValue] = []
          }
          // Create a new object, store the reference for future uses
          currentObj = {}
          ;(parentObj[currentValue] as IcalObject[]).push(currentObj)
          break
        case "END":
          currentObj = parentObj
          parentObj = parents.pop() as IcalObject
          break
        default:
          if (currentObj[currentKey]) {
            if (!Array.isArray(currentObj[currentKey])) {
              currentObj[currentKey] = [currentObj[currentKey]] as string[]
            }
            ;(currentObj[currentKey] as string[]).push(currentValue)
          } else {
            ;(currentObj[currentKey] as string) = currentValue
          }
      }
    }
  }
  return output
}

/**
 * Take JSON, revert back to ical
 */
function revert(object: IcalObject): string {
  const lines = []

  for (const key in object) {
    const value = object[key]
    if (Array.isArray(value)) {
      if (key === "RDATE") {
        ;(value as string[]).forEach((item: string) => {
          lines.push(key + ":" + item)
        })
      } else {
        ;(value as IcalObject[]).forEach((item: IcalObject) => {
          lines.push("BEGIN:" + key)
          lines.push(revert(item))
          lines.push("END:" + key)
        })
      }
    } else {
      let fullLine = key + ":" + value
      do {
        // According to ical spec, lines of text should be no longer
        // than 75 octets
        lines.push(fullLine.substr(0, 75))
        fullLine = SPACE + fullLine.substr(75)
      } while (fullLine.length > 1)
    }
  }

  return lines.join("\n")
}

try {
  const argv = await getCommandLineArguments()

  if (argv.calendar) {
    let calendar_file = argv.calendar
    let input_file = calendar_file

    console.log(`Processing calendar: "${calendar_file}"`)

    let calendar_view = await parseCalendarFromFile(input_file)
    let output_file = `${argv.outputdir}/${path.parse(input_file).name}.html`
    let force = argv.force || false
    let template_dir = argv.templatedir
    let open = argv.open

    let template_file = `${template_dir}/${calendar_view.template}.${calendar_view.lang}.html`
    await renderOutput(calendar_view, template_file, output_file, force)

    console.log(calendar_view)

    console.log(`Output file: ${output_file}`)

    if (argv.open) {
      const p = Deno.run({
        cmd: ["open", output_file],
      })
      const status = await p.status()
    }
  }

  console.log("😼\n")
  //console.log(Cat.getCat())
} catch (error: any) {
  console.log(error)
}

async function getCommandLineArguments() {
  return yargs(Deno.args)
    .option("calendar", {
      alias: "c",
      description: "Calendar file",
      type: "string",
      demandOption: true,
    })

    .option("templatedir", {
      alias: "t",
      description: "Template directory",
      type: "string",
      default: `./`,
      demandOption: true,
    })

    .option("outputdir", {
      alias: "o",
      description: "Output directory",
      type: "string",
      default: `./`,
      demandOption: true,
    })

    .option("force", {
      alias: "f",
      description: "Force overwrite",
      type: "boolean",
      demandOption: false,
      default: false,
    })

    .option("open", {
      alias: "x",
      description: "auto-open the result",
      type: "boolean",
      demandOption: false,
      default: false,
    })

    .help()
    .alias("help", "h").argv
}

async function renderOutput(
  calendar_view: any,
  template_file: string,
  output_file: string,
  force: boolean
) {
  if (await fileExists(output_file)) {
    if (!force) {
      throw new Error(
        `Output file already exists: "${output_file}". use --force to replace`
      )
    }
  }

  if (!(await fileExists(template_file))) {
    throw new Error(`File template not found: "${template_file}"`)
  }

  let template = await readFile(template_file)
  let rendered_template = Mustache.render(template, calendar_view)
  let unredered_lines = rendered_template.split("\n").filter((v) => {
    return /{{.*}}/.test(v)
  })
  if (!unredered_lines.length) {
    console.log("Missing tags:")
    console.log(unredered_lines)
  }

  await Deno.writeTextFile(output_file, rendered_template)
}

async function readFile(template_file: string): Promise<string> {
  const decoder = new TextDecoder()
  const data = await Deno.readFile(template_file)
  return decoder.decode(data)
}

async function parseCalendarFromFile(calendar_filename: string) {
  let ics_content = await readFile(calendar_filename)

  const json_content = convert(ics_content)

  const event_list = json_content.VCALENDAR[0].VEVENT

  let lang: string = ""
  let template: string = ""

  let events_simplified = event_list.map((evento: any) => {
    let simplified_event: any = {
      summary: evento.SUMMARY,
      url: evento.URL,
      location: unescape(evento.LOCATION || ""),
    }

    let start_key = getDtstartKey(evento)
    let end_key = getDtendKey(evento)

    let start = evento[start_key]
    let end = evento[end_key]

    simplified_event.start_timezone = start_key.split("TZID=")[1]
    simplified_event.end_timezone = end_key.split("TZID=")[1]

    let start_time = start.split(`T`)[1] || ``
    let end_time = end.split(`T`)[1] || ``

    simplified_event.start_time = `${start_time.substr(
      0,
      2
    )}:${start_time.substr(2, 2)}`
    simplified_event.end_time = `${end_time.substr(0, 2)}:${end_time.substr(
      2,
      2
    )}`

    simplified_event.start_moment = moment.tz(
      start,
      simplified_event.start_timezone
    )
    simplified_event.end_moment = moment.tz(end, simplified_event.end_timezone)

    let lines_from_description = unescape(evento.DESCRIPTION).split(`\n`)

    lines_from_description.map((line: string) => {
      let splited_line = line.split(`:`)

      function toTitleCase(str: string) {
        return str.replace(/\w\S*/g, function (txt) {
          return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
        })
      }

      if (splited_line.length >= 2) {
        let key = splited_line[0].trim()
        let value = splited_line.splice(1).join(`:`).trim()

        let newkey = key.split(" ").map(toTitleCase).join("")

        simplified_event[newkey] = value
      }
    })

    let xtemplate = evento["X-TEMPLATE"]
    let xlang = evento["X-LANG"]

    if (xtemplate) {
      template = xtemplate
    }

    if (xlang) {
      lang = xlang
    }

    let tag = evento["X-CARLTAG"]?.trim()

    simplified_event.tag = tag

    return simplified_event
  })

  let sorted_events = events_simplified.sort((a: any, b: any) => {
    return a.start_moment.diff(b.start_moment)
  })

  let previous_event: any = null
  let complete_events = sorted_events.map((e: any, i: number) => {
    e.sequence = i + 1

    if (!e.tag) {
      e.tag = `event-${i + 1}`
    }

    moment.locale(lang)

    e.start_date_human = e.start_moment.format("LL")
    e.end_date_human = e.end_moment.format("LL")

    e.start_human = e.start_moment.format("LLLL")
    e.end_human = e.end_moment.format("LLLL")

    e.duration_human = moment
      .duration(e.end_moment.diff(e.start_moment))
      .humanize()

    if (previous_event) {
      e.wait_interval = moment
        .duration(previous_event.end_moment.diff(e.start_moment))
        .humanize()
    }

    previous_event = e

    return e
  })

  let calendar_view: any = {
    lang: lang,
    template: template,
    client_name: json_content.VCALENDAR[0]["X-WR-CALNAME"],
  }

  complete_events.map((e: any) => {
    if (e.tag) {
      calendar_view[e.tag] = e
    }
  })

  let range = getRange(
    calendar_view.clientinfo.start_moment,
    calendar_view.clientinfo.end_moment
  )
  range.map((d: any, i: number) => {
    d.locale(calendar_view.lang)
    calendar_view[`day${i + 1}`] = d.format("LL")
  })

  if (!calendar_view.template) {
    throw new Error(`The file ${calendar_filename} has no x-template`)
  }

  if (!calendar_view.lang) {
    throw new Error(`The file ${calendar_filename} has no x-lang`)
  }

  if (!sorted_events.length) {
    throw new Error(`The file ${calendar_filename} has no events`)
  }

  return calendar_view
}

function getDtendKey(evento: any) {
  return Object.keys(evento).filter((k) => k.indexOf("DTEND") >= 0)[0]
}

function getDtstartKey(evento: any) {
  return Object.keys(evento).filter((k) => k.indexOf("DTSTART") >= 0)[0]
}

function getRange(startDate: any, endDate: any) {
  let diff = Math.trunc(moment.duration(endDate.diff(startDate)).asDays())
  let range: any[] = []
  for (let i = 0; i < diff; i++) {
    range.push(moment(startDate).add(i, "day"))
  }
  return range
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await Deno.stat(filename)
    // successful, file or directory must exist
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // file or directory does not exist
      return false
    } else {
      // unexpected error, maybe permissions, pass it along
      throw error
    }
  }
}
