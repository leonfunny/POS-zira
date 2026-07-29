$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# The wire protocol is ASCII base64 on stdin and one compact UTF-8 JSON object
# per stdout line. This avoids Windows PowerShell 5.1 console-codepage damage
# to Polish/Vietnamese receipt text.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

$workerSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Zira.Thermal
{
    public sealed class RasterLine
    {
        public string Text { get; set; }
        public string RightText { get; set; }
        public bool Bold { get; set; }
        public bool Big { get; set; }
        public bool Center { get; set; }
        public bool Separator { get; set; }
    }

    public sealed class RasterResult
    {
        public byte[] Data { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public long RenderMs { get; set; }
    }

    public sealed class RawPrintResult
    {
        public uint JobId { get; set; }
        public int BytesWritten { get; set; }
        public long SpoolMs { get; set; }
        public long PreflightMs { get; set; }
        public long PresenceProbeMs { get; set; }
        public string PresenceReason { get; set; }
        public string PortName { get; set; }
        public long ReconcileMs { get; set; }
        public uint PrinterStatus { get; set; }
        public string PrinterStatusText { get; set; }
        public uint JobStatus { get; set; }
        public string JobStatusText { get; set; }
    }

    public sealed class WorkerException : Exception
    {
        public string Code { get; private set; }
        public string Stage { get; private set; }
        public string FailureClass { get; private set; }

        public WorkerException(
            string code,
            string stage,
            string failureClass,
            string message
        ) : base(message)
        {
            Code = code;
            Stage = stage;
            FailureClass = failureClass;
        }

        public WorkerException(
            string code,
            string stage,
            string failureClass,
            string message,
            Exception inner
        ) : base(message, inner)
        {
            Code = code;
            Stage = stage;
            FailureClass = failureClass;
        }
    }

    public static class Worker
    {
        private const string SafeBeforePrint = "SAFE_BEFORE_PRINT";
        private const string UncertainAfterPrint = "UNCERTAIN_AFTER_PRINT";
        private const int MaxRawJobBytes = 8 * 1024 * 1024;
        private const int ErrorInsufficientBuffer = 122;
        private const int ErrorFileNotFound = 2;
        private const int ErrorInvalidParameter = 87;
        private const int JobReconcileWindowMs = 300;
        private const int JobReconcilePollMs = 25;
        private const uint JobControlDelete = 5;
        private const uint DigcfPresent = 0x00000002;
        private const uint DigcfAllClasses = 0x00000004;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        private const uint PrinterStatusPaused = 0x00000001;
        private const uint PrinterStatusError = 0x00000002;
        private const uint PrinterStatusPendingDeletion = 0x00000004;
        private const uint PrinterStatusPaperJam = 0x00000008;
        private const uint PrinterStatusPaperOut = 0x00000010;
        private const uint PrinterStatusManualFeed = 0x00000020;
        private const uint PrinterStatusPaperProblem = 0x00000040;
        private const uint PrinterStatusOffline = 0x00000080;
        private const uint PrinterStatusIoActive = 0x00000100;
        private const uint PrinterStatusBusy = 0x00000200;
        private const uint PrinterStatusPrinting = 0x00000400;
        private const uint PrinterStatusOutputBinFull = 0x00000800;
        private const uint PrinterStatusNotAvailable = 0x00001000;
        private const uint PrinterStatusWaiting = 0x00002000;
        private const uint PrinterStatusProcessing = 0x00004000;
        private const uint PrinterStatusInitializing = 0x00008000;
        private const uint PrinterStatusWarmingUp = 0x00010000;
        private const uint PrinterStatusTonerLow = 0x00020000;
        private const uint PrinterStatusNoToner = 0x00040000;
        private const uint PrinterStatusPagePunt = 0x00080000;
        private const uint PrinterStatusUserIntervention = 0x00100000;
        private const uint PrinterStatusOutOfMemory = 0x00200000;
        private const uint PrinterStatusDoorOpen = 0x00400000;
        private const uint PrinterStatusServerUnknown = 0x00800000;
        private const uint PrinterStatusPowerSave = 0x01000000;

        private const uint FatalPrinterStatusMask =
            PrinterStatusPaused |
            PrinterStatusError |
            PrinterStatusPendingDeletion |
            PrinterStatusPaperJam |
            PrinterStatusPaperOut |
            PrinterStatusManualFeed |
            PrinterStatusPaperProblem |
            PrinterStatusOffline |
            PrinterStatusOutputBinFull |
            PrinterStatusNotAvailable |
            PrinterStatusNoToner |
            PrinterStatusPagePunt |
            PrinterStatusUserIntervention |
            PrinterStatusOutOfMemory |
            PrinterStatusDoorOpen |
            PrinterStatusServerUnknown;

        private const uint JobStatusPaused = 0x00000001;
        private const uint JobStatusError = 0x00000002;
        private const uint JobStatusDeleting = 0x00000004;
        private const uint JobStatusSpooling = 0x00000008;
        private const uint JobStatusPrinting = 0x00000010;
        private const uint JobStatusOffline = 0x00000020;
        private const uint JobStatusPaperOut = 0x00000040;
        private const uint JobStatusPrinted = 0x00000080;
        private const uint JobStatusDeleted = 0x00000100;
        private const uint JobStatusBlockedDeviceQueue = 0x00000200;
        private const uint JobStatusUserIntervention = 0x00000400;
        private const uint JobStatusRestart = 0x00000800;
        private const uint JobStatusComplete = 0x00001000;
        private const uint JobStatusRetained = 0x00002000;

        private const uint FatalJobStatusMask =
            JobStatusPaused |
            JobStatusError |
            JobStatusDeleting |
            JobStatusOffline |
            JobStatusPaperOut |
            JobStatusDeleted |
            JobStatusBlockedDeviceQueue |
            JobStatusUserIntervention;

        private const uint CompleteJobStatusMask =
            JobStatusPrinted |
            JobStatusComplete;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DOC_INFO_1
        {
            [MarshalAs(UnmanagedType.LPWStr)]
            public string pDocName;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string pOutputFile;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string pDatatype;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PRINTER_INFO_2
        {
            public IntPtr pServerName;
            public IntPtr pPrinterName;
            public IntPtr pShareName;
            public IntPtr pPortName;
            public IntPtr pDriverName;
            public IntPtr pComment;
            public IntPtr pLocation;
            public IntPtr pDevMode;
            public IntPtr pSepFile;
            public IntPtr pPrintProcessor;
            public IntPtr pDatatype;
            public IntPtr pParameters;
            public IntPtr pSecurityDescriptor;
            public uint Attributes;
            public uint Priority;
            public uint DefaultPriority;
            public uint StartTime;
            public uint UntilTime;
            public uint Status;
            public uint cJobs;
            public uint AveragePPM;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SP_DEVINFO_DATA
        {
            public uint cbSize;
            public Guid ClassGuid;
            public uint DevInst;
            public IntPtr Reserved;
        }

        private sealed class PrinterSnapshot
        {
            public uint Status { get; set; }
            public string PortName { get; set; }
        }

        private sealed class PresenceProbeResult
        {
            public bool Present { get; set; }
            public string Reason { get; set; }
            public long ElapsedMs { get; set; }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SYSTEMTIME
        {
            public ushort Year;
            public ushort Month;
            public ushort DayOfWeek;
            public ushort Day;
            public ushort Hour;
            public ushort Minute;
            public ushort Second;
            public ushort Milliseconds;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOB_INFO_1
        {
            public uint JobId;
            public IntPtr pPrinterName;
            public IntPtr pMachineName;
            public IntPtr pUserName;
            public IntPtr pDocument;
            public IntPtr pDatatype;
            public IntPtr pStatus;
            public uint Status;
            public uint Priority;
            public uint Position;
            public uint TotalPages;
            public uint PagesPrinted;
            public SYSTEMTIME Submitted;
        }

        private sealed class JobQueryResult
        {
            public bool Found { get; set; }
            public bool Gone { get; set; }
            public uint Status { get; set; }
            public int ErrorCode { get; set; }
        }

        private sealed class JobReconcileResult
        {
            public uint Status { get; set; }
            public string StatusText { get; set; }
            public long ElapsedMs { get; set; }
        }

        [DllImport(
            "winspool.drv",
            EntryPoint = "OpenPrinterW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenPrinter(
            string printerName,
            out IntPtr printerHandle,
            IntPtr defaults
        );

        [DllImport(
            "winspool.drv",
            EntryPoint = "GetPrinterW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetPrinter(
            IntPtr printerHandle,
            uint level,
            IntPtr printerInfo,
            uint bufferSize,
            out uint needed
        );

        [DllImport(
            "winspool.drv",
            EntryPoint = "GetJobW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetJob(
            IntPtr printerHandle,
            uint jobId,
            uint level,
            IntPtr jobInfo,
            uint bufferSize,
            out uint needed
        );

        [DllImport(
            "winspool.drv",
            EntryPoint = "SetJobW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetJob(
            IntPtr printerHandle,
            uint jobId,
            uint level,
            IntPtr jobInfo,
            uint command
        );

        [DllImport(
            "winspool.drv",
            EntryPoint = "StartDocPrinterW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        private static extern uint StartDocPrinter(
            IntPtr printerHandle,
            int level,
            ref DOC_INFO_1 docInfo
        );

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool StartPagePrinter(IntPtr printerHandle);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WritePrinter(
            IntPtr printerHandle,
            byte[] bytes,
            int byteCount,
            out int bytesWritten
        );

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EndPagePrinter(IntPtr printerHandle);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EndDocPrinter(IntPtr printerHandle);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ClosePrinter(IntPtr printerHandle);

        [DllImport(
            "setupapi.dll",
            EntryPoint = "SetupDiGetClassDevsW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        private static extern IntPtr SetupDiGetClassDevs(
            IntPtr classGuid,
            string enumerator,
            IntPtr parentWindow,
            uint flags
        );

        [DllImport("setupapi.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetupDiEnumDeviceInfo(
            IntPtr deviceInfoSet,
            uint memberIndex,
            ref SP_DEVINFO_DATA deviceInfoData
        );

        [DllImport(
            "setupapi.dll",
            EntryPoint = "SetupDiGetDeviceInstanceIdW",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetupDiGetDeviceInstanceId(
            IntPtr deviceInfoSet,
            ref SP_DEVINFO_DATA deviceInfoData,
            StringBuilder deviceInstanceId,
            uint deviceInstanceIdSize,
            out uint requiredSize
        );

        [DllImport("setupapi.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetupDiDestroyDeviceInfoList(
            IntPtr deviceInfoSet
        );

        public static RasterResult Render(
            RasterLine[] sourceLines,
            int width,
            bool includeInit,
            bool includeFeed,
            bool includeCut
        )
        {
            if (width < 128 || width > 2048)
            {
                throw new WorkerException(
                    "INVALID_RASTER_WIDTH",
                    "RENDER_VALIDATE",
                    SafeBeforePrint,
                    "Raster width must be between 128 and 2048 pixels"
                );
            }

            RasterLine[] lines = sourceLines ?? new RasterLine[0];
            Stopwatch timer = Stopwatch.StartNew();

            using (Font normalFont = new Font("Consolas", 8, FontStyle.Regular))
            using (Font boldFont = new Font("Consolas", 8, FontStyle.Bold))
            using (Font bigFont = new Font("Consolas", 14, FontStyle.Bold))
            using (StringFormat measureFormat = CreateStringFormat())
            {
                int totalHeight = 30;
                using (Bitmap measureBitmap = new Bitmap(1, 1, PixelFormat.Format32bppArgb))
                {
                    measureBitmap.SetResolution(203, 203);
                    using (Graphics measureGraphics = Graphics.FromImage(measureBitmap))
                    {
                        foreach (RasterLine line in lines)
                        {
                            if (line != null && line.Separator)
                            {
                                totalHeight += 16;
                                continue;
                            }

                            RasterLine safeLine = line ?? new RasterLine();
                            Font font = SelectFont(safeLine, normalFont, boldFont, bigFont);
                            string text = String.IsNullOrEmpty(safeLine.Text) ? " " : safeLine.Text;
                            SizeF leftSize = measureGraphics.MeasureString(
                                text,
                                font,
                                9999,
                                measureFormat
                            );
                            float lineHeight = leftSize.Height;
                            if (!String.IsNullOrEmpty(safeLine.RightText))
                            {
                                SizeF rightSize = measureGraphics.MeasureString(
                                    safeLine.RightText,
                                    font,
                                    9999,
                                    measureFormat
                                );
                                lineHeight = Math.Max(lineHeight, rightSize.Height);
                            }
                            totalHeight += (int)Math.Ceiling(lineHeight);
                        }
                    }
                }

                int height = Math.Max(totalHeight, 10);
                using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                {
                    bitmap.SetResolution(203, 203);
                    using (Graphics graphics = Graphics.FromImage(bitmap))
                    using (StringFormat drawFormat = CreateStringFormat())
                    {
                        graphics.Clear(Color.White);
                        graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

                        const int margin = 8;
                        float y = 0;
                        foreach (RasterLine line in lines)
                        {
                            if (line != null && line.Separator)
                            {
                                using (Pen pen = new Pen(Color.Black, 1))
                                {
                                    graphics.DrawLine(
                                        pen,
                                        margin,
                                        y + 8,
                                        width - margin,
                                        y + 8
                                    );
                                }
                                y += 16;
                                continue;
                            }

                            RasterLine safeLine = line ?? new RasterLine();
                            Font font = SelectFont(safeLine, normalFont, boldFont, bigFont);
                            string text = String.IsNullOrEmpty(safeLine.Text) ? " " : safeLine.Text;
                            SizeF leftSize = graphics.MeasureString(
                                text,
                                font,
                                width,
                                drawFormat
                            );
                            float lineHeight = leftSize.Height;

                            if (!String.IsNullOrEmpty(safeLine.RightText))
                            {
                                graphics.DrawString(
                                    text,
                                    font,
                                    Brushes.Black,
                                    margin,
                                    y,
                                    drawFormat
                                );
                                SizeF rightSize = graphics.MeasureString(
                                    safeLine.RightText,
                                    font,
                                    width,
                                    drawFormat
                                );
                                float rightX = width - margin - rightSize.Width;
                                graphics.DrawString(
                                    safeLine.RightText,
                                    font,
                                    Brushes.Black,
                                    rightX,
                                    y,
                                    drawFormat
                                );
                                lineHeight = Math.Max(lineHeight, rightSize.Height);
                            }
                            else if (safeLine.Center)
                            {
                                float x = Math.Max(margin, (width - leftSize.Width) / 2);
                                graphics.DrawString(
                                    text,
                                    font,
                                    Brushes.Black,
                                    x,
                                    y,
                                    drawFormat
                                );
                            }
                            else
                            {
                                graphics.DrawString(
                                    text,
                                    font,
                                    Brushes.Black,
                                    margin,
                                    y,
                                    drawFormat
                                );
                            }

                            y += (float)Math.Ceiling(lineHeight);
                        }
                    }

                    byte[] raster = ConvertBitmapToMonochrome(bitmap);
                    int bytesPerRow = (width + 7) / 8;
                    byte[] output = BuildEscPosRaster(
                        raster,
                        bytesPerRow,
                        height,
                        includeInit,
                        includeFeed,
                        includeCut
                    );
                    timer.Stop();
                    return new RasterResult
                    {
                        Data = output,
                        Width = width,
                        Height = height,
                        RenderMs = timer.ElapsedMilliseconds
                    };
                }
            }
        }

        public static RawPrintResult PrintRaw(
            string printerName,
            byte[] data,
            string documentName,
            string[] expectedUsbVids
        )
        {
            if (String.IsNullOrWhiteSpace(printerName))
            {
                throw new WorkerException(
                    "INVALID_PRINTER_NAME",
                    "PRINT_VALIDATE",
                    SafeBeforePrint,
                    "Printer name is required"
                );
            }
            if (data == null || data.Length == 0)
            {
                throw new WorkerException(
                    "INVALID_PRINT_DATA",
                    "PRINT_VALIDATE",
                    SafeBeforePrint,
                    "Raw print data must not be empty"
                );
            }
            if (data.Length > MaxRawJobBytes)
            {
                throw new WorkerException(
                    "PRINT_DATA_TOO_LARGE",
                    "PRINT_VALIDATE",
                    SafeBeforePrint,
                    "Raw print data exceeds the 8 MiB safety limit"
                );
            }

            Stopwatch timer = Stopwatch.StartNew();
            IntPtr handle = IntPtr.Zero;
            uint jobId = 0;
            bool jobSubmitted = false;
            bool documentStarted = false;
            bool pageStarted = false;
            try
            {
                if (!OpenPrinter(printerName, out handle, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("OPEN_PRINTER", error, SafeBeforePrint);
                }

                Stopwatch preflightTimer = Stopwatch.StartNew();
                PrinterSnapshot printer = QueryPrinterSnapshot(handle);
                PresenceProbeResult presence = ProbePhysicalPresence(
                    printer.PortName,
                    expectedUsbVids
                );
                if (!presence.Present)
                {
                    throw new WorkerException(
                        "PRINTER_NOT_PRESENT",
                        "PHYSICAL_PRESENCE_PREFLIGHT",
                        SafeBeforePrint,
                        "Printer is not physically present on " +
                        printer.PortName + ": " + presence.Reason
                    );
                }
                uint printerStatus = printer.Status;
                preflightTimer.Stop();
                string printerStatusText = DescribePrinterStatus(printerStatus);
                uint fatalPrinterStatus = printerStatus & FatalPrinterStatusMask;
                if (fatalPrinterStatus != 0)
                {
                    throw new WorkerException(
                        "PRINTER_NOT_READY",
                        "PRINTER_PREFLIGHT",
                        SafeBeforePrint,
                        "Printer is not ready before StartDocPrinter: " +
                        DescribePrinterStatus(fatalPrinterStatus) +
                        " (status=0x" + printerStatus.ToString("X8") + ")"
                    );
                }

                DOC_INFO_1 info = new DOC_INFO_1
                {
                    pDocName = String.IsNullOrWhiteSpace(documentName)
                        ? "Zira AI Receipt"
                        : documentName,
                    pOutputFile = null,
                    pDatatype = "RAW"
                };

                jobId = StartDocPrinter(handle, 1, ref info);
                if (jobId == 0)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("START_DOC", error, SafeBeforePrint);
                }
                jobSubmitted = true;
                documentStarted = true;

                if (!StartPagePrinter(handle))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("START_PAGE", error, UncertainAfterPrint);
                }
                pageStarted = true;

                int written;
                if (!WritePrinter(handle, data, data.Length, out written))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("WRITE", error, UncertainAfterPrint);
                }
                if (written != data.Length)
                {
                    throw new WorkerException(
                        "PARTIAL_WRITE",
                        "WRITE",
                        UncertainAfterPrint,
                        "WritePrinter accepted " + written + " of " + data.Length + " bytes"
                    );
                }

                if (!EndPagePrinter(handle))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("END_PAGE", error, UncertainAfterPrint);
                }
                pageStarted = false;

                if (!EndDocPrinter(handle))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("END_DOC", error, UncertainAfterPrint);
                }
                documentStarted = false;

                long spoolMs = timer.ElapsedMilliseconds;
                JobReconcileResult reconcile = ReconcileJob(handle, jobId);
                timer.Stop();
                return new RawPrintResult
                {
                    JobId = jobId,
                    BytesWritten = written,
                    SpoolMs = spoolMs,
                    PreflightMs = preflightTimer.ElapsedMilliseconds,
                    PresenceProbeMs = presence.ElapsedMs,
                    PresenceReason = presence.Reason,
                    PortName = printer.PortName,
                    ReconcileMs = reconcile.ElapsedMs,
                    PrinterStatus = printerStatus,
                    PrinterStatusText = printerStatusText,
                    JobStatus = reconcile.Status,
                    JobStatusText = reconcile.StatusText
                };
            }
            catch (WorkerException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new WorkerException(
                    "UNEXPECTED_PRINT_ERROR",
                    jobSubmitted ? "PRINT_AFTER_START_DOC" : "PRINT_BEFORE_START_DOC",
                    jobSubmitted ? UncertainAfterPrint : SafeBeforePrint,
                    error.Message,
                    error
                );
            }
            finally
            {
                // Cleanup calls are best-effort only. If a call above failed
                // after StartDocPrinter, the caller already receives
                // UNCERTAIN_AFTER_PRINT and must not replay the job.
                if (pageStarted && handle != IntPtr.Zero)
                {
                    try { EndPagePrinter(handle); } catch { }
                }
                if (documentStarted && handle != IntPtr.Zero)
                {
                    try { EndDocPrinter(handle); } catch { }
                }
                if (handle != IntPtr.Zero)
                {
                    try { ClosePrinter(handle); } catch { }
                }
            }
        }

        private static PrinterSnapshot QueryPrinterSnapshot(IntPtr printerHandle)
        {
            uint needed;
            bool sized = GetPrinter(
                printerHandle,
                2,
                IntPtr.Zero,
                0,
                out needed
            );
            int sizeError = Marshal.GetLastWin32Error();
            if (!sized && (sizeError != ErrorInsufficientBuffer || needed == 0))
            {
                throw new WorkerException(
                    "PRINTER_STATUS_QUERY_FAILED",
                    "PRINTER_PREFLIGHT",
                    SafeBeforePrint,
                    "GetPrinterW size query failed with Win32 error " + sizeError
                );
            }
            if (needed == 0)
            {
                throw new WorkerException(
                    "PRINTER_STATUS_QUERY_FAILED",
                    "PRINTER_PREFLIGHT",
                    SafeBeforePrint,
                    "GetPrinterW returned an empty PRINTER_INFO_2 buffer"
                );
            }

            IntPtr buffer = Marshal.AllocHGlobal(checked((int)needed));
            try
            {
                if (!GetPrinter(printerHandle, 2, buffer, needed, out needed))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new WorkerException(
                        "PRINTER_STATUS_QUERY_FAILED",
                        "PRINTER_PREFLIGHT",
                        SafeBeforePrint,
                        "GetPrinterW failed with Win32 error " + error
                    );
                }

                PRINTER_INFO_2 info =
                    (PRINTER_INFO_2)Marshal.PtrToStructure(
                        buffer,
                        typeof(PRINTER_INFO_2)
                    );
                return new PrinterSnapshot
                {
                    Status = info.Status,
                    PortName = Marshal.PtrToStringUni(info.pPortName) ?? String.Empty
                };
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static PresenceProbeResult ProbePhysicalPresence(
            string portName,
            string[] expectedUsbVids
        )
        {
            Stopwatch timer = Stopwatch.StartNew();
            string normalizedPort = String.IsNullOrWhiteSpace(portName)
                ? String.Empty
                : portName.Trim().ToUpperInvariant();

            if (
                !System.Text.RegularExpressions.Regex.IsMatch(
                    normalizedPort,
                    "^(USB\\d+|DOT4_\\d+)$",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase
                )
            )
            {
                timer.Stop();
                return new PresenceProbeResult
                {
                    Present = true,
                    Reason = "SPOOLER_PORT_TRUSTED",
                    ElapsedMs = timer.ElapsedMilliseconds
                };
            }

            string[] presentDeviceIds = EnumeratePresentDeviceInstanceIds();
            foreach (string rawDeviceId in presentDeviceIds)
            {
                string deviceId = (rawDeviceId ?? String.Empty).ToUpperInvariant();
                if (
                    deviceId.StartsWith("USBPRINT\\", StringComparison.Ordinal) &&
                    deviceId.EndsWith(normalizedPort, StringComparison.Ordinal)
                )
                {
                    timer.Stop();
                    return new PresenceProbeResult
                    {
                        Present = true,
                        Reason = "USBPRINT_PORT_PRESENT",
                        ElapsedMs = timer.ElapsedMilliseconds
                    };
                }
            }

            string[] vids = expectedUsbVids ?? new string[0];
            foreach (string rawVid in vids)
            {
                string vid = (rawVid ?? String.Empty).Trim().ToUpperInvariant();
                if (!System.Text.RegularExpressions.Regex.IsMatch(vid, "^[0-9A-F]{4}$"))
                {
                    continue;
                }
                string marker = "VID_" + vid;
                foreach (string rawDeviceId in presentDeviceIds)
                {
                    string deviceId = (rawDeviceId ?? String.Empty).ToUpperInvariant();
                    if (deviceId.IndexOf(marker, StringComparison.Ordinal) >= 0)
                    {
                        timer.Stop();
                        return new PresenceProbeResult
                        {
                            Present = true,
                            Reason = "EXPECTED_USB_VID_PRESENT",
                            ElapsedMs = timer.ElapsedMilliseconds
                        };
                    }
                }
            }

            timer.Stop();
            if (vids.Length == 0)
            {
                // Preserve the legacy behavior for unknown printer brands:
                // without an expected VID table, Winspool is the only signal.
                return new PresenceProbeResult
                {
                    Present = true,
                    Reason = "SPOOLER_TRUSTED_NO_EXPECTED_VID",
                    ElapsedMs = timer.ElapsedMilliseconds
                };
            }

            return new PresenceProbeResult
            {
                Present = false,
                Reason = "USB_DEVICE_NOT_PRESENT",
                ElapsedMs = timer.ElapsedMilliseconds
            };
        }

        private static string[] EnumeratePresentDeviceInstanceIds()
        {
            IntPtr deviceInfoSet = SetupDiGetClassDevs(
                IntPtr.Zero,
                null,
                IntPtr.Zero,
                DigcfPresent | DigcfAllClasses
            );
            if (deviceInfoSet == InvalidHandleValue)
            {
                int error = Marshal.GetLastWin32Error();
                throw new WorkerException(
                    "PRINTER_PNP_QUERY_FAILED",
                    "PHYSICAL_PRESENCE_PREFLIGHT",
                    SafeBeforePrint,
                    "SetupDiGetClassDevsW failed with Win32 error " + error
                );
            }

            List<string> ids = new List<string>();
            try
            {
                for (uint index = 0; ; index++)
                {
                    SP_DEVINFO_DATA deviceInfo = new SP_DEVINFO_DATA();
                    deviceInfo.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    if (!SetupDiEnumDeviceInfo(deviceInfoSet, index, ref deviceInfo))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 259)
                        {
                            break;
                        }
                        throw new WorkerException(
                            "PRINTER_PNP_QUERY_FAILED",
                            "PHYSICAL_PRESENCE_PREFLIGHT",
                            SafeBeforePrint,
                            "SetupDiEnumDeviceInfo failed with Win32 error " + error
                        );
                    }

                    StringBuilder instanceId = new StringBuilder(1024);
                    uint requiredSize;
                    if (SetupDiGetDeviceInstanceId(
                        deviceInfoSet,
                        ref deviceInfo,
                        instanceId,
                        (uint)instanceId.Capacity,
                        out requiredSize
                    ))
                    {
                        ids.Add(instanceId.ToString());
                    }
                }
            }
            finally
            {
                SetupDiDestroyDeviceInfoList(deviceInfoSet);
            }
            return ids.ToArray();
        }

        private static JobQueryResult QueryJob(
            IntPtr printerHandle,
            uint jobId
        )
        {
            uint needed;
            bool sized = GetJob(
                printerHandle,
                jobId,
                1,
                IntPtr.Zero,
                0,
                out needed
            );
            int sizeError = Marshal.GetLastWin32Error();

            if (!sized && (
                sizeError == ErrorInvalidParameter ||
                sizeError == ErrorFileNotFound
            ))
            {
                return new JobQueryResult
                {
                    Found = false,
                    Gone = true,
                    Status = 0,
                    ErrorCode = sizeError
                };
            }

            if (!sized && (sizeError != ErrorInsufficientBuffer || needed == 0))
            {
                return new JobQueryResult
                {
                    Found = false,
                    Gone = false,
                    Status = 0,
                    ErrorCode = sizeError
                };
            }

            if (needed == 0)
            {
                return new JobQueryResult
                {
                    Found = false,
                    Gone = false,
                    Status = 0,
                    ErrorCode = sizeError
                };
            }

            IntPtr buffer = Marshal.AllocHGlobal(checked((int)needed));
            try
            {
                if (!GetJob(
                    printerHandle,
                    jobId,
                    1,
                    buffer,
                    needed,
                    out needed
                ))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (
                        error == ErrorInvalidParameter ||
                        error == ErrorFileNotFound
                    )
                    {
                        return new JobQueryResult
                        {
                            Found = false,
                            Gone = true,
                            Status = 0,
                            ErrorCode = error
                        };
                    }
                    return new JobQueryResult
                    {
                        Found = false,
                        Gone = false,
                        Status = 0,
                        ErrorCode = error
                    };
                }

                JOB_INFO_1 info =
                    (JOB_INFO_1)Marshal.PtrToStructure(
                        buffer,
                        typeof(JOB_INFO_1)
                    );
                return new JobQueryResult
                {
                    Found = true,
                    Gone = false,
                    Status = info.Status,
                    ErrorCode = 0
                };
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static JobReconcileResult ReconcileJob(
            IntPtr printerHandle,
            uint jobId
        )
        {
            Stopwatch timer = Stopwatch.StartNew();
            uint lastStatus = 0;
            string lastStatusText = "PENDING";

            while (true)
            {
                JobQueryResult query = QueryJob(printerHandle, jobId);
                if (query.Gone)
                {
                    timer.Stop();
                    return new JobReconcileResult
                    {
                        Status = lastStatus,
                        StatusText = "GONE",
                        ElapsedMs = timer.ElapsedMilliseconds
                    };
                }

                if (!query.Found)
                {
                    timer.Stop();
                    throw new WorkerException(
                        "JOB_STATUS_QUERY_FAILED",
                        "JOB_RECONCILE",
                        UncertainAfterPrint,
                        "GetJobW failed for accepted job " + jobId +
                        " with Win32 error " + query.ErrorCode
                    );
                }

                lastStatus = query.Status;
                lastStatusText = DescribeJobStatus(lastStatus);
                uint fatalStatus = lastStatus & FatalJobStatusMask;
                if (fatalStatus != 0)
                {
                    BestEffortDeleteJob(printerHandle, jobId);
                    timer.Stop();
                    throw new WorkerException(
                        "PRINT_JOB_NOT_READY",
                        "JOB_RECONCILE",
                        UncertainAfterPrint,
                        "Accepted print job " + jobId +
                        " entered " + DescribeJobStatus(fatalStatus) +
                        " (status=0x" + lastStatus.ToString("X8") +
                        "); delete requested"
                    );
                }

                if ((lastStatus & CompleteJobStatusMask) != 0)
                {
                    timer.Stop();
                    return new JobReconcileResult
                    {
                        Status = lastStatus,
                        StatusText = lastStatusText,
                        ElapsedMs = timer.ElapsedMilliseconds
                    };
                }

                if (timer.ElapsedMilliseconds >= JobReconcileWindowMs)
                {
                    timer.Stop();
                    return new JobReconcileResult
                    {
                        Status = lastStatus,
                        StatusText = lastStatusText,
                        ElapsedMs = timer.ElapsedMilliseconds
                    };
                }

                System.Threading.Thread.Sleep(JobReconcilePollMs);
            }
        }

        private static void BestEffortDeleteJob(
            IntPtr printerHandle,
            uint jobId
        )
        {
            try
            {
                SetJob(
                    printerHandle,
                    jobId,
                    0,
                    IntPtr.Zero,
                    JobControlDelete
                );
            }
            catch
            {
                // The caller still receives UNCERTAIN_AFTER_PRINT. Cleanup
                // must never hide the exact job status that caused it.
            }
        }

        private static string DescribePrinterStatus(uint status)
        {
            if (status == 0) return "READY";
            List<string> values = new List<string>();
            AddStatus(values, status, PrinterStatusPaused, "PAUSED");
            AddStatus(values, status, PrinterStatusError, "ERROR");
            AddStatus(values, status, PrinterStatusPendingDeletion, "PENDING_DELETION");
            AddStatus(values, status, PrinterStatusPaperJam, "PAPER_JAM");
            AddStatus(values, status, PrinterStatusPaperOut, "PAPER_OUT");
            AddStatus(values, status, PrinterStatusManualFeed, "MANUAL_FEED");
            AddStatus(values, status, PrinterStatusPaperProblem, "PAPER_PROBLEM");
            AddStatus(values, status, PrinterStatusOffline, "OFFLINE");
            AddStatus(values, status, PrinterStatusIoActive, "IO_ACTIVE");
            AddStatus(values, status, PrinterStatusBusy, "BUSY");
            AddStatus(values, status, PrinterStatusPrinting, "PRINTING");
            AddStatus(values, status, PrinterStatusOutputBinFull, "OUTPUT_BIN_FULL");
            AddStatus(values, status, PrinterStatusNotAvailable, "NOT_AVAILABLE");
            AddStatus(values, status, PrinterStatusWaiting, "WAITING");
            AddStatus(values, status, PrinterStatusProcessing, "PROCESSING");
            AddStatus(values, status, PrinterStatusInitializing, "INITIALIZING");
            AddStatus(values, status, PrinterStatusWarmingUp, "WARMING_UP");
            AddStatus(values, status, PrinterStatusTonerLow, "TONER_LOW");
            AddStatus(values, status, PrinterStatusNoToner, "NO_TONER");
            AddStatus(values, status, PrinterStatusPagePunt, "PAGE_PUNT");
            AddStatus(values, status, PrinterStatusUserIntervention, "USER_INTERVENTION");
            AddStatus(values, status, PrinterStatusOutOfMemory, "OUT_OF_MEMORY");
            AddStatus(values, status, PrinterStatusDoorOpen, "DOOR_OPEN");
            AddStatus(values, status, PrinterStatusServerUnknown, "SERVER_UNKNOWN");
            AddStatus(values, status, PrinterStatusPowerSave, "POWER_SAVE");
            return String.Join("|", values.ToArray());
        }

        private static string DescribeJobStatus(uint status)
        {
            if (status == 0) return "PENDING";
            List<string> values = new List<string>();
            AddStatus(values, status, JobStatusPaused, "PAUSED");
            AddStatus(values, status, JobStatusError, "ERROR");
            AddStatus(values, status, JobStatusDeleting, "DELETING");
            AddStatus(values, status, JobStatusSpooling, "SPOOLING");
            AddStatus(values, status, JobStatusPrinting, "PRINTING");
            AddStatus(values, status, JobStatusOffline, "OFFLINE");
            AddStatus(values, status, JobStatusPaperOut, "PAPER_OUT");
            AddStatus(values, status, JobStatusPrinted, "PRINTED");
            AddStatus(values, status, JobStatusDeleted, "DELETED");
            AddStatus(values, status, JobStatusBlockedDeviceQueue, "BLOCKED_DEVICE_QUEUE");
            AddStatus(values, status, JobStatusUserIntervention, "USER_INTERVENTION");
            AddStatus(values, status, JobStatusRestart, "RESTART");
            AddStatus(values, status, JobStatusComplete, "COMPLETE");
            AddStatus(values, status, JobStatusRetained, "RETAINED");
            return String.Join("|", values.ToArray());
        }

        private static void AddStatus(
            List<string> values,
            uint status,
            uint flag,
            string name
        )
        {
            if ((status & flag) != 0) values.Add(name);
        }

        private static StringFormat CreateStringFormat()
        {
            StringFormat format = new StringFormat();
            format.Trimming = StringTrimming.None;
            format.FormatFlags = StringFormatFlags.NoWrap;
            return format;
        }

        private static Font SelectFont(
            RasterLine line,
            Font normalFont,
            Font boldFont,
            Font bigFont
        )
        {
            if (line.Big) return bigFont;
            if (line.Bold) return boldFont;
            return normalFont;
        }

        private static byte[] ConvertBitmapToMonochrome(Bitmap bitmap)
        {
            int width = bitmap.Width;
            int height = bitmap.Height;
            int bytesPerRow = (width + 7) / 8;
            byte[] raster = new byte[bytesPerRow * height];
            Rectangle bounds = new Rectangle(0, 0, width, height);
            BitmapData bitmapData = bitmap.LockBits(
                bounds,
                ImageLockMode.ReadOnly,
                PixelFormat.Format32bppArgb
            );

            try
            {
                int absoluteStride = Math.Abs(bitmapData.Stride);
                byte[] pixels = new byte[absoluteStride];

                for (int row = 0; row < height; row++)
                {
                    IntPtr sourceRowPointer = IntPtr.Add(
                        bitmapData.Scan0,
                        row * bitmapData.Stride
                    );
                    Marshal.Copy(sourceRowPointer, pixels, 0, absoluteStride);
                    int targetRow = row * bytesPerRow;
                    for (int column = 0; column < width; column++)
                    {
                        int pixel = column * 4;
                        int blue = pixels[pixel];
                        int green = pixels[pixel + 1];
                        int red = pixels[pixel + 2];
                        int gray = ((red * 299) + (green * 587) + (blue * 114)) / 1000;
                        if (gray < 128)
                        {
                            raster[targetRow + (column / 8)] |=
                                (byte)(1 << (7 - (column % 8)));
                        }
                    }
                }
            }
            finally
            {
                bitmap.UnlockBits(bitmapData);
            }

            return raster;
        }

        private static byte[] BuildEscPosRaster(
            byte[] raster,
            int bytesPerRow,
            int height,
            bool includeInit,
            bool includeFeed,
            bool includeCut
        )
        {
            using (MemoryStream output = new MemoryStream())
            {
                if (includeInit)
                {
                    output.WriteByte(0x1B);
                    output.WriteByte(0x40);
                }

                output.WriteByte(0x1D);
                output.WriteByte(0x76);
                output.WriteByte(0x30);
                output.WriteByte(0x00);
                output.WriteByte((byte)(bytesPerRow & 0xFF));
                output.WriteByte((byte)((bytesPerRow >> 8) & 0xFF));
                output.WriteByte((byte)(height & 0xFF));
                output.WriteByte((byte)((height >> 8) & 0xFF));
                output.Write(raster, 0, raster.Length);

                if (includeFeed)
                {
                    output.WriteByte(0x1B);
                    output.WriteByte(0x64);
                    output.WriteByte(0x03);
                }
                if (includeCut)
                {
                    output.WriteByte(0x1D);
                    output.WriteByte(0x56);
                    output.WriteByte(0x01);
                }
                return output.ToArray();
            }
        }

        private static WorkerException Win32Failure(
            string stage,
            int error,
            string failureClass
        )
        {
            return new WorkerException(
                "WIN32_" + error,
                stage,
                failureClass,
                stage + " failed with Win32 error " + error
            );
        }
    }
}
'@

Add-Type -TypeDefinition $workerSource -ReferencedAssemblies 'System.Drawing.dll'

function Write-ProtocolObject {
    param([Parameter(Mandatory = $true)] [object] $Value)

    $json = $Value | ConvertTo-Json -Compress -Depth 12
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-RootException {
    param([Parameter(Mandatory = $true)] [System.Exception] $Exception)

    $current = $Exception
    while (
        $null -ne $current.InnerException -and
        -not $current.PSObject.Properties['FailureClass']
    ) {
        $current = $current.InnerException
    }
    return $current
}

Write-ProtocolObject @{
    type = 'ready'
    protocolVersion = 1
    pid = $PID
}

while ($true) {
    $encodedLine = [Console]::In.ReadLine()
    if ($null -eq $encodedLine) {
        break
    }
    if ([String]::IsNullOrWhiteSpace($encodedLine)) {
        continue
    }

    $requestId = $null
    $action = $null
    try {
        $requestJson = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($encodedLine)
        )
        $request = $requestJson | ConvertFrom-Json
        $requestId = [int]$request.id
        $action = [string]$request.action
        $payload = $request.payload

        switch ($action) {
            'ping' {
                Write-ProtocolObject @{
                    type = 'response'
                    id = $requestId
                    ok = $true
                    result = @{
                        protocolVersion = 1
                        pid = $PID
                    }
                }
            }

            'render' {
                $rasterLines = New-Object 'System.Collections.Generic.List[Zira.Thermal.RasterLine]'
                foreach ($line in @($payload.lines)) {
                    $rasterLine = New-Object Zira.Thermal.RasterLine
                    $rasterLine.Text = if ($null -eq $line.text) { '' } else { [string]$line.text }
                    $rasterLine.RightText = if ($null -eq $line.rightText) { $null } else { [string]$line.rightText }
                    $rasterLine.Bold = [bool]$line.bold
                    $rasterLine.Big = [bool]$line.big
                    $rasterLine.Center = [bool]$line.center
                    $rasterLine.Separator = [bool]$line.separator
                    $rasterLines.Add($rasterLine)
                }

                $renderResult = [Zira.Thermal.Worker]::Render(
                    $rasterLines.ToArray(),
                    [int]$payload.width,
                    [bool]$payload.includeInit,
                    [bool]$payload.includeFeed,
                    [bool]$payload.includeCut
                )
                Write-ProtocolObject @{
                    type = 'response'
                    id = $requestId
                    ok = $true
                    result = @{
                        dataBase64 = [Convert]::ToBase64String($renderResult.Data)
                        width = $renderResult.Width
                        height = $renderResult.Height
                        bytes = $renderResult.Data.Length
                        renderMs = $renderResult.RenderMs
                    }
                }
            }

            'print' {
                $rawBytes = [Convert]::FromBase64String([string]$payload.dataBase64)
                $expectedUsbVids = @(
                    @($payload.expectedUsbVids) |
                        ForEach-Object { [string]$_ }
                )
                $printResult = [Zira.Thermal.Worker]::PrintRaw(
                    [string]$payload.printerName,
                    $rawBytes,
                    [string]$payload.documentName,
                    [string[]]$expectedUsbVids
                )
                Write-ProtocolObject @{
                    type = 'response'
                    id = $requestId
                    ok = $true
                    result = @{
                        jobId = $printResult.JobId
                        bytesWritten = $printResult.BytesWritten
                        spoolMs = $printResult.SpoolMs
                        preflightMs = $printResult.PreflightMs
                        presenceProbeMs = $printResult.PresenceProbeMs
                        presenceReason = $printResult.PresenceReason
                        portName = $printResult.PortName
                        reconcileMs = $printResult.ReconcileMs
                        printerStatus = $printResult.PrinterStatus
                        printerStatusText = $printResult.PrinterStatusText
                        jobStatus = $printResult.JobStatus
                        jobStatusText = $printResult.JobStatusText
                    }
                }
            }

            'stop' {
                Write-ProtocolObject @{
                    type = 'response'
                    id = $requestId
                    ok = $true
                    result = @{ stopped = $true }
                }
                break
            }

            default {
                throw "Unsupported worker action: $action"
            }
        }

        if ($action -eq 'stop') {
            break
        }
    }
    catch {
        $root = Get-RootException $_.Exception
        $failureClass = 'SAFE_BEFORE_PRINT'
        $errorCode = 'WORKER_ACTION_FAILED'
        $errorStage = if ($null -eq $action) { 'PARSE_REQUEST' } else { 'WORKER_ACTION' }

        if ($root.PSObject.Properties['FailureClass']) {
            $failureClass = [string]$root.FailureClass
        }
        if ($root.PSObject.Properties['Code']) {
            $errorCode = [string]$root.Code
        }
        if ($root.PSObject.Properties['Stage']) {
            $errorStage = [string]$root.Stage
        }

        Write-ProtocolObject @{
            type = 'response'
            id = $requestId
            ok = $false
            error = @{
                code = $errorCode
                stage = $errorStage
                failureClass = $failureClass
                message = [string]$root.Message
            }
        }
    }
}
