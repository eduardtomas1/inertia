using System;
using System.Reflection;

public static class IdentityProof {
  public static int Main(string[] arguments) {
    var type = Assembly.LoadFrom(arguments[0]).GetType("InertiaRuntimeJob", true);
    var identity = type.GetMethod("TerminalIdentity", BindingFlags.NonPublic | BindingFlags.Static);
    string token = "54c58470-60dc-4b77-919b-3f40f75a729a";
    UInt64 birth = 134400000000000000;
    string original = (string)identity.Invoke(null, new object[] { token, (UInt32)42, birth });
    string same = (string)identity.Invoke(null, new object[] { token, (UInt32)42, birth });
    string replacement = (string)identity.Invoke(null, new object[] { token, (UInt32)42, birth + 1 });
    string otherPid = (string)identity.Invoke(null, new object[] { token, (UInt32)43, birth });
    if (String.IsNullOrEmpty(original) || original != same || original == replacement || original == otherPid) return 1;
    Console.WriteLine("NATIVE_IDENTITY_DISTINCT");
    return 7;
  }
}
