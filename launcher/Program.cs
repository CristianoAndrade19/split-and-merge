using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Split & Merge Studio")]
[assembly: AssemblyDescription("Estudio local para corte, fusao Corpo + Face com IA e igualacao perceptual de tom de pele.")]
[assembly: AssemblyCompany("Split & Merge Studio")]
[assembly: AssemblyProduct("Split & Merge Studio")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

namespace SplitAndMergeLauncher
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static TcpListener _listener;
        private static volatile bool _running = true;
        private static int _port = 0;
        private static string _baseUrl = "";

        private static readonly object _stateLock = new object();
        private static bool _clientEverConnected = false;
        private static DateTime _startUtc = DateTime.UtcNow;
        private static DateTime _lastHeartbeatUtc = DateTime.UtcNow;
        private static DateTime _pendingCloseUtc = DateTime.MinValue;
        private static int _activeSessions = 0;

        private static Process _browserProc = null;
        private static bool _usedDedicatedAppProcess = false;
        private static NotifyIcon _trayIcon = null;

        private static readonly Dictionary<string, ResourceEntry> _routes =
            new Dictionary<string, ResourceEntry>(StringComparer.OrdinalIgnoreCase);

        private sealed class ResourceEntry
        {
            public byte[] Data;
            public string ContentType;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool headlessServer = false;
            int requestedPort = 0;

            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    string a = args[i] ?? "";
                    if (string.Equals(a, "--headless-server", StringComparison.OrdinalIgnoreCase))
                    {
                        headlessServer = true;
                    }
                    else if (a.StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
                    {
                        int parsed;
                        if (int.TryParse(a.Substring(7), out parsed) && parsed > 0 && parsed < 65536)
                        {
                            requestedPort = parsed;
                        }
                    }
                }
            }

            string appDataRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SplitAndMergeStudio"
            );
            try { Directory.CreateDirectory(appDataRoot); } catch { }
            string portFile = Path.Combine(appDataRoot, "running_port.txt");

            // Single-instance reuse when launched normally without explicit --port or --headless-server
            bool createdNewMutex = true;
            Mutex instanceMutex = null;
            if (!headlessServer && requestedPort == 0)
            {
                try
                {
                    instanceMutex = new Mutex(true, @"Local\SplitAndMergeStudio_ServerMutex_v1", out createdNewMutex);
                }
                catch
                {
                    createdNewMutex = true;
                }

                if (!createdNewMutex)
                {
                    int existingPort = ReadExistingPort(portFile);
                    if (existingPort > 0 && PingExistingServer(existingPort))
                    {
                        LaunchAppWindow("http://127.0.0.1:" + existingPort + "/", appDataRoot);
                        return 0;
                    }
                }
            }

            try
            {
                LoadEmbeddedAssets();
            }
            catch (Exception ex)
            {
                if (!headlessServer)
                {
                    MessageBox.Show(
                        "Erro ao carregar recursos internos do executavel:\n" + ex.Message,
                        "Split & Merge Studio",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                return 1;
            }

            try
            {
                _listener = new TcpListener(IPAddress.Loopback, requestedPort);
                _listener.Start();
                _port = ((IPEndPoint)_listener.LocalEndpoint).Port;
                _baseUrl = "http://127.0.0.1:" + _port + "/";

                if (!headlessServer && requestedPort == 0)
                {
                    try { File.WriteAllText(portFile, _port.ToString(), Encoding.ASCII); } catch { }
                }
            }
            catch (Exception ex)
            {
                if (!headlessServer)
                {
                    MessageBox.Show(
                        "Nao foi possivel iniciar o servidor local em 127.0.0.1:\n" + ex.Message,
                        "Split & Merge Studio",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                return 2;
            }

            Thread serverThread = new Thread(AcceptLoop);
            serverThread.IsBackground = true;
            serverThread.Name = "SplitMergeEmbeddedHttp";
            serverThread.Start();

            if (headlessServer)
            {
                Console.WriteLine("SERVER_READY " + _baseUrl);
                Console.Out.Flush();
                while (_running)
                {
                    Thread.Sleep(200);
                }
                Cleanup(portFile, instanceMutex, createdNewMutex);
                return 0;
            }

            SetupTrayIcon(appDataRoot);
            LaunchAppWindow(_baseUrl, appDataRoot);

            System.Windows.Forms.Timer lifecycleTimer = new System.Windows.Forms.Timer();
            lifecycleTimer.Interval = 500;
            lifecycleTimer.Tick += delegate
            {
                CheckLifecycleAndExitIfClosed();
            };
            lifecycleTimer.Start();

            Application.Run();

            lifecycleTimer.Stop();
            Cleanup(portFile, instanceMutex, createdNewMutex);
            return 0;
        }

        private static void Cleanup(string portFile, Mutex mutex, bool ownsMutex)
        {
            _running = false;
            try { if (_listener != null) _listener.Stop(); } catch { }
            try
            {
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Dispose();
                }
            }
            catch { }

            if (ownsMutex)
            {
                try { if (File.Exists(portFile)) File.Delete(portFile); } catch { }
                try { if (mutex != null) mutex.ReleaseMutex(); } catch { }
            }
            try { if (mutex != null) mutex.Dispose(); } catch { }
        }

        private static int ReadExistingPort(string portFile)
        {
            try
            {
                if (!File.Exists(portFile)) return 0;
                string txt = File.ReadAllText(portFile).Trim();
                int p;
                if (int.TryParse(txt, out p) && p > 0 && p < 65536) return p;
            }
            catch { }
            return 0;
        }

        private static bool PingExistingServer(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/ping");
                req.Timeout = 700;
                req.Method = "GET";
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void LoadEmbeddedAssets()
        {
            Assembly asm = Assembly.GetExecutingAssembly();

            // Build injected lifecycle script inside index.html so closing the window exits cleanly
            byte[] rawIndex = ReadResourceBytes(asm, "app.index.html");
            string html = Encoding.UTF8.GetString(rawIndex);

            const string headHook = "<link rel=\"icon\" type=\"image/x-icon\" href=\"/favicon.ico\" />\r\n</head>";
            int headIdx = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
            if (headIdx >= 0)
            {
                html = html.Substring(0, headIdx) + headHook + html.Substring(headIdx + 7);
            }

            const string lifecycleScript = @"
  <script>
  (function () {
    var sid = Math.random().toString(36).slice(2);
    function sendPing(path) {
      try {
        fetch(path + '?s=' + sid, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(function () {});
      } catch (e) {}
    }
    sendPing('/api/open');
    setInterval(function () { sendPing('/api/heartbeat'); }, 2500);
    window.addEventListener('pagehide', function () {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/closed?s=' + sid, '1');
        } else {
          sendPing('/api/closed');
        }
      } catch (e) {}
    });
  })();
  </script>
</body>";

            int bodyIdx = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (bodyIdx >= 0)
            {
                html = html.Substring(0, bodyIdx) + lifecycleScript + html.Substring(bodyIdx + 7);
            }

            byte[] finalIndexBytes = Encoding.UTF8.GetBytes(html);
            _routes["/"] = new ResourceEntry { Data = finalIndexBytes, ContentType = "text/html; charset=utf-8" };
            _routes["/index.html"] = new ResourceEntry { Data = finalIndexBytes, ContentType = "text/html; charset=utf-8" };

            RegisterAsset(asm, "/css/styles.css", "app.css.styles.css", "text/css; charset=utf-8");
            RegisterAsset(asm, "/js/prompts.js", "app.js.prompts.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/prompt_original_hair.txt", "app.prompt_original_hair.txt", "text/plain; charset=utf-8");
            RegisterAsset(asm, "/prompt_reference_hair.txt", "app.prompt_reference_hair.txt", "text/plain; charset=utf-8");
            RegisterAsset(asm, "/js/types.js", "app.js.types.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/js/geometry.js", "app.js.geometry.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/js/imageOps.js", "app.js.imageOps.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/js/seamMerge.js", "app.js.seamMerge.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/js/skinMatch.js", "app.js.skinMatch.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/js/viewport.js", "app.js.viewport.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/js/app.js", "app.js.app.js", "application/javascript; charset=utf-8");
            RegisterAsset(asm, "/favicon.ico", "app.favicon.ico", "image/x-icon");
        }

        private static void RegisterAsset(Assembly asm, string route, string resName, string mime)
        {
            byte[] bytes = ReadResourceBytes(asm, resName);
            _routes[route] = new ResourceEntry { Data = bytes, ContentType = mime };
        }

        private static byte[] ReadResourceBytes(Assembly asm, string resName)
        {
            using (Stream s = asm.GetManifestResourceStream(resName))
            {
                if (s == null)
                {
                    throw new FileNotFoundException("Recurso ausente: " + resName);
                }
                using (MemoryStream ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    return ms.ToArray();
                }
            }
        }

        private static void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client = null;
                try
                {
                    client = _listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                catch
                {
                    if (client != null)
                    {
                        try { client.Close(); } catch { }
                    }
                    if (!_running) break;
                }
            }
        }

        private static void HandleClient(object state)
        {
            TcpClient client = (TcpClient)state;
            try
            {
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 5000;
                using (NetworkStream stream = client.GetStream())
                {
                    // Read HTTP request header
                    byte[] buf = new byte[8192];
                    int totalRead = 0;
                    while (totalRead < buf.Length)
                    {
                        int n = stream.Read(buf, totalRead, buf.Length - totalRead);
                        if (n <= 0) break;
                        totalRead += n;
                        string partial = Encoding.ASCII.GetString(buf, 0, totalRead);
                        if (partial.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0)
                        {
                            break;
                        }
                    }

                    if (totalRead <= 0) return;

                    string headerText = Encoding.UTF8.GetString(buf, 0, totalRead);
                    int lineEnd = headerText.IndexOf("\r\n", StringComparison.Ordinal);
                    string reqLine = lineEnd >= 0 ? headerText.Substring(0, lineEnd) : headerText;
                    string[] parts = reqLine.Split(' ');
                    if (parts.Length < 2) return;

                    string rawTarget = parts[1];
                    int qIdx = rawTarget.IndexOf('?');
                    string path = qIdx >= 0 ? rawTarget.Substring(0, qIdx) : rawTarget;
                    path = Uri.UnescapeDataString(path);
                    if (string.IsNullOrEmpty(path)) path = "/";

                    // Lifecycle & control API endpoints
                    if (string.Equals(path, "/api/ping", StringComparison.OrdinalIgnoreCase))
                    {
                        WriteResponse(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":true}"));
                        return;
                    }
                    if (string.Equals(path, "/api/open", StringComparison.OrdinalIgnoreCase))
                    {
                        lock (_stateLock)
                        {
                            _clientEverConnected = true;
                            _activeSessions++;
                            _lastHeartbeatUtc = DateTime.UtcNow;
                            _pendingCloseUtc = DateTime.MinValue;
                        }
                        WriteResponse(stream, "204 No Content", "text/plain", new byte[0]);
                        return;
                    }
                    if (string.Equals(path, "/api/heartbeat", StringComparison.OrdinalIgnoreCase))
                    {
                        lock (_stateLock)
                        {
                            _clientEverConnected = true;
                            _lastHeartbeatUtc = DateTime.UtcNow;
                            _pendingCloseUtc = DateTime.MinValue;
                        }
                        WriteResponse(stream, "204 No Content", "text/plain", new byte[0]);
                        return;
                    }
                    if (string.Equals(path, "/api/closed", StringComparison.OrdinalIgnoreCase))
                    {
                        lock (_stateLock)
                        {
                            if (_activeSessions > 0) _activeSessions--;
                            if (_activeSessions <= 0)
                            {
                                _activeSessions = 0;
                                _pendingCloseUtc = DateTime.UtcNow;
                            }
                        }
                        WriteResponse(stream, "204 No Content", "text/plain", new byte[0]);
                        return;
                    }
                    if (string.Equals(path, "/api/shutdown", StringComparison.OrdinalIgnoreCase))
                    {
                        WriteResponse(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"bye\":true}"));
                        _running = false;
                        try { Application.Exit(); } catch { }
                        return;
                    }
                    if (string.Equals(path, "/api/data-folders", StringComparison.OrdinalIgnoreCase))
                    {
                        string dataDir = GetDataRoot();
                        List<string> folders = new List<string>();
                        if (Directory.Exists(dataDir))
                        {
                            string[] subs = Directory.GetDirectories(dataDir);
                            List<KeyValuePair<int, string>> numDirs = new List<KeyValuePair<int, string>>();
                            List<string> otherDirs = new List<string>();
                            foreach (string s in subs)
                            {
                                string name = Path.GetFileName(s);
                                int n;
                                if (int.TryParse(name, out n))
                                    numDirs.Add(new KeyValuePair<int, string>(n, name));
                                else
                                    otherDirs.Add(name);
                            }
                            numDirs.Sort((a, b) => b.Key.CompareTo(a.Key));
                            foreach (var p in numDirs) folders.Add(p.Value);
                            foreach (var s in otherDirs) folders.Add(s);
                        }
                        string defaultFolder = folders.Count > 0 ? folders[0] : "";
                        StringBuilder sb = new StringBuilder();
                        sb.Append("{\"folders\":[");
                        for (int i = 0; i < folders.Count; i++)
                        {
                            if (i > 0) sb.Append(",");
                            sb.Append("\"").Append(folders[i]).Append("\"");
                        }
                        sb.Append("],\"defaultFolder\":\"").Append(defaultFolder).Append("\"}");
                        byte[] jsonBytes = Encoding.UTF8.GetBytes(sb.ToString());
                        WriteResponse(stream, "200 OK", "application/json; charset=utf-8", jsonBytes);
                        return;
                    }
                    if (string.Equals(path, "/api/save-image", StringComparison.OrdinalIgnoreCase))
                    {
                        int contentLen = 0;
                        string lenHeader = "Content-Length:";
                        int clIdx = headerText.IndexOf(lenHeader, StringComparison.OrdinalIgnoreCase);
                        if (clIdx >= 0)
                        {
                            int endL = headerText.IndexOf("\r\n", clIdx);
                            if (endL > clIdx)
                            {
                                string lenStr = headerText.Substring(clIdx + lenHeader.Length, endL - (clIdx + lenHeader.Length)).Trim();
                                int.TryParse(lenStr, out contentLen);
                            }
                        }

                        int headerEnd = headerText.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                        int bodyStartInBuf = headerEnd + 4;
                        int alreadyRead = totalRead - bodyStartInBuf;
                        byte[] bodyBytes = new byte[contentLen];
                        if (alreadyRead > 0)
                        {
                            Buffer.BlockCopy(buf, bodyStartInBuf, bodyBytes, 0, Math.Min(alreadyRead, contentLen));
                        }
                        int curBodyRead = Math.Min(alreadyRead, contentLen);
                        while (curBodyRead < contentLen)
                        {
                            int r = stream.Read(bodyBytes, curBodyRead, contentLen - curBodyRead);
                            if (r <= 0) break;
                            curBodyRead += r;
                        }

                        string bodyStr = Encoding.UTF8.GetString(bodyBytes, 0, curBodyRead);
                        string folder = ExtractJsonField(bodyStr, "folder");
                        string filename = ExtractJsonField(bodyStr, "filename");
                        string dataUrl = ExtractJsonField(bodyStr, "dataUrl");

                        if (string.IsNullOrEmpty(filename)) filename = "imagem_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".png";
                        if (!filename.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) filename += ".png";
                        filename = Path.GetFileName(filename);

                        string dataRoot = GetDataRoot();
                        string targetDir = string.IsNullOrEmpty(folder) ? dataRoot : Path.Combine(dataRoot, folder.Trim('\\', '/'));
                        Directory.CreateDirectory(targetDir);
                        string targetPath = Path.Combine(targetDir, filename);

                        if (dataUrl.Contains(","))
                        {
                            dataUrl = dataUrl.Substring(dataUrl.IndexOf(',') + 1);
                        }
                        byte[] imageBytes = Convert.FromBase64String(dataUrl);
                        File.WriteAllBytes(targetPath, imageBytes);

                        string relPath = string.IsNullOrEmpty(folder) ? ("data/" + filename) : ("data/" + folder + "/" + filename);
                        string resJson = "{\"ok\":true,\"path\":\"" + relPath.Replace("\\", "/") + "\",\"fullPath\":\"" + targetPath.Replace("\\", "\\\\") + "\",\"bytes\":" + imageBytes.Length + "}";
                        WriteResponse(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(resJson));
                        return;
                    }
                    if (string.Equals(path, "/api/open-data-folder", StringComparison.OrdinalIgnoreCase))
                    {
                        string folder = "";
                        int fIdx = rawTarget.IndexOf("folder=", StringComparison.OrdinalIgnoreCase);
                        if (fIdx >= 0)
                        {
                            string sub = rawTarget.Substring(fIdx + 7);
                            int amp = sub.IndexOf('&');
                            if (amp >= 0) sub = sub.Substring(0, amp);
                            folder = Uri.UnescapeDataString(sub).Trim('\\', '/');
                        }
                        string dataRoot = GetDataRoot();
                        string targetDir = string.IsNullOrEmpty(folder) ? dataRoot : Path.Combine(dataRoot, folder);
                        Directory.CreateDirectory(targetDir);
                        try { Process.Start("explorer.exe", "\"" + targetDir + "\""); } catch { }
                        WriteResponse(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":true}"));
                        return;
                    }

                    ResourceEntry entry;
                    if (_routes.TryGetValue(path, out entry))
                    {
                        lock (_stateLock)
                        {
                            _clientEverConnected = true;
                            _lastHeartbeatUtc = DateTime.UtcNow;
                            _pendingCloseUtc = DateTime.MinValue;
                        }
                        WriteResponse(stream, "200 OK", entry.ContentType, entry.Data);
                    }
                    else
                    {
                        byte[] nf = Encoding.UTF8.GetBytes("404 Not Found: " + path);
                        WriteResponse(stream, "404 Not Found", "text/plain; charset=utf-8", nf);
                    }
                }
            }
            catch
            {
                // Ignore client socket resets
            }
            finally
            {
                try { client.Close(); } catch { }
            }
        }

        private static void WriteResponse(NetworkStream stream, string status, string contentType, byte[] body)
        {
            string hdr =
                "HTTP/1.1 " + status + "\r\n" +
                "Content-Type: " + contentType + "\r\n" +
                "Content-Length: " + body.Length + "\r\n" +
                "Cache-Control: no-store, no-cache, must-revalidate\r\n" +
                "X-Content-Type-Options: nosniff\r\n" +
                "Connection: close\r\n\r\n";
            byte[] hdrBytes = Encoding.ASCII.GetBytes(hdr);
            stream.Write(hdrBytes, 0, hdrBytes.Length);
            if (body.Length > 0)
            {
                stream.Write(body, 0, body.Length);
            }
            stream.Flush();
        }

        private static string GetDataRoot()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string dir1 = Path.Combine(baseDir, "data");
            if (Directory.Exists(dir1)) return dir1;

            string cwd = Directory.GetCurrentDirectory();
            string dir2 = Path.Combine(cwd, "data");
            if (Directory.Exists(dir2)) return dir2;

            try
            {
                Directory.CreateDirectory(dir1);
                return dir1;
            }
            catch
            {
                Directory.CreateDirectory(dir2);
                return dir2;
            }
        }

        private static string ExtractJsonField(string json, string key)
        {
            string pattern = "\"" + key + "\"";
            int idx = json.IndexOf(pattern, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return "";
            int colon = json.IndexOf(':', idx + pattern.Length);
            if (colon < 0) return "";
            int startVal = colon + 1;
            while (startVal < json.Length && char.IsWhiteSpace(json[startVal])) startVal++;
            if (startVal >= json.Length) return "";
            if (json[startVal] == '\"')
            {
                startVal++;
                StringBuilder sb = new StringBuilder();
                for (int i = startVal; i < json.Length; i++)
                {
                    if (json[i] == '\\' && i + 1 < json.Length)
                    {
                        sb.Append(json[i + 1]);
                        i++;
                    }
                    else if (json[i] == '\"')
                    {
                        break;
                    }
                    else
                    {
                        sb.Append(json[i]);
                    }
                }
                return sb.ToString();
            }
            else
            {
                int endVal = startVal;
                while (endVal < json.Length && json[endVal] != ',' && json[endVal] != '}' && !char.IsWhiteSpace(json[endVal]))
                {
                    endVal++;
                }
                return json.Substring(startVal, endVal - startVal);
            }
        }

        private static void SetupTrayIcon(string appDataRoot)
        {
            try
            {
                Icon ico = null;
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.favicon.ico"))
                {
                    if (s != null) ico = new Icon(s);
                }

                ContextMenu menu = new ContextMenu();
                menu.MenuItems.Add("Abrir Janela do Split & Merge Studio", delegate
                {
                    LaunchAppWindow(_baseUrl, appDataRoot);
                });
                menu.MenuItems.Add("Copiar Endereco Local (" + _baseUrl + ")", delegate
                {
                    try { Clipboard.SetText(_baseUrl); } catch { }
                });
                menu.MenuItems.Add("-");
                menu.MenuItems.Add("Encerrar Split & Merge Studio", delegate
                {
                    _running = false;
                    Application.Exit();
                });

                _trayIcon = new NotifyIcon();
                _trayIcon.Icon = ico ?? SystemIcons.Application;
                _trayIcon.Text = "Split & Merge Studio (Rodando)";
                _trayIcon.ContextMenu = menu;
                _trayIcon.Visible = true;
                _trayIcon.DoubleClick += delegate
                {
                    LaunchAppWindow(_baseUrl, appDataRoot);
                };
            }
            catch
            {
                // Non-fatal if shell notification area is unavailable
            }
        }

        private static void LaunchAppWindow(string url, string appDataRoot)
        {
            string browserExe = FindChromiumExecutable();
            if (!string.IsNullOrEmpty(browserExe))
            {
                try
                {
                    string profileDir = Path.Combine(appDataRoot, "AppWindowProfile");
                    Directory.CreateDirectory(profileDir);

                    string args =
                        "--app=\"" + url + "\" " +
                        "--user-data-dir=\"" + profileDir + "\" " +
                        "--window-size=1460,920 " +
                        "--no-first-run " +
                        "--no-default-browser-check " +
                        "--disable-extensions " +
                        "--disable-features=Translate,msEdgeWelcomePage,msSidebar";

                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = browserExe;
                    psi.Arguments = args;
                    psi.UseShellExecute = false;

                    Process proc = Process.Start(psi);
                    if (proc != null && _browserProc == null)
                    {
                        _browserProc = proc;
                        _usedDedicatedAppProcess = true;
                    }
                    return;
                }
                catch
                {
                    // Fall back to default system browser below
                }
            }

            try
            {
                _usedDedicatedAppProcess = false;
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Servidor ativo em " + url + "\nAbra esse endereco no navegador.\n(" + ex.Message + ")",
                    "Split & Merge Studio",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
        }

        private static string FindChromiumExecutable()
        {
            List<string> candidates = new List<string>();

            // 1. Google Chrome (cleanest zero-chrome --app window)
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe");
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe");
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe");
            AddRegistryAppPath(candidates, "chrome.exe");

            // 2. Microsoft Edge (pre-installed on Windows 10 & Windows 11)
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe");
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe");
            AddRegistryAppPath(candidates, "msedge.exe");

            // 3. Brave Browser
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"BraveSoftware\Brave-Browser\Application\brave.exe");
            AddCandidate(candidates, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"BraveSoftware\Brave-Browser\Application\brave.exe");

            for (int i = 0; i < candidates.Count; i++)
            {
                string path = candidates[i];
                if (!string.IsNullOrEmpty(path) && File.Exists(path))
                {
                    return path;
                }
            }
            return null;
        }

        private static void AddCandidate(List<string> list, string root, string rel)
        {
            if (!string.IsNullOrEmpty(root))
            {
                list.Add(Path.Combine(root, rel));
            }
        }

        private static void AddRegistryAppPath(List<string> list, string exeName)
        {
            string subKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exeName;
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(subKey))
                {
                    if (k != null)
                    {
                        string val = k.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(val)) list.Add(val.Trim('"'));
                    }
                }
            }
            catch { }

            try
            {
                using (RegistryKey k = Registry.LocalMachine.OpenSubKey(subKey))
                {
                    if (k != null)
                    {
                        string val = k.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(val)) list.Add(val.Trim('"'));
                    }
                }
            }
            catch { }
        }

        private static void CheckLifecycleAndExitIfClosed()
        {
            if (!_running)
            {
                Application.Exit();
                return;
            }

            DateTime now = DateTime.UtcNow;

            // Fast check 1: dedicated --app Chromium process exited after running
            if (_usedDedicatedAppProcess && _browserProc != null)
            {
                try
                {
                    if (_browserProc.HasExited && (now - _startUtc).TotalSeconds > 2.5)
                    {
                        bool anyActive;
                        lock (_stateLock)
                        {
                            anyActive = _activeSessions > 0 && (now - _lastHeartbeatUtc).TotalSeconds < 3.5;
                        }
                        if (!anyActive)
                        {
                            _running = false;
                            Application.Exit();
                            return;
                        }
                    }
                }
                catch { }
            }

            // Fast check 2: pagehide beacon notified us that all windows closed (with 1.6s grace for F5 refresh)
            lock (_stateLock)
            {
                if (_clientEverConnected && _pendingCloseUtc != DateTime.MinValue)
                {
                    if ((now - _pendingCloseUtc).TotalMilliseconds > 1600)
                    {
                        _running = false;
                        Application.Exit();
                        return;
                    }
                }

                // Fallback check 3: if startup failed and no browser ever connected after 45s
                if (!_clientEverConnected && (now - _startUtc).TotalSeconds > 45)
                {
                    _running = false;
                    Application.Exit();
                    return;
                }
            }
        }
    }
}

