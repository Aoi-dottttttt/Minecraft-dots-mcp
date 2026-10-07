extends SceneTree
var errors = 0
var checks = 0
func check(condition, name):
 checks += 1
 if not condition: errors += 1; print("FAIL: " + name)
func _initialize():
 var viewer = load("res://viewer.gd").new()
 var now = int(Time.get_unix_time_from_system())
 var frame = {"schemaVersion":1,"bounded":true,"status":"live","sourceGeneration":1,"sourceSequence":2,"capturedAt":Time.get_datetime_string_from_unix_time(now)+"Z","validUntil":Time.get_datetime_string_from_unix_time(now+5)+"Z","position":{"x":0.5,"y":64,"z":0.5},"bounds":{"origin":{"x":-8,"y":58,"z":-8},"size":{"x":17,"y":13,"z":17}},"unknownCells":0,"unknownIndices":[],"sections":[]}
 frame = JSON.parse_string(JSON.stringify(frame))
 check(viewer.valid_frame(frame), "JSON numeric types accepted with bounded dimensions")
 var invalid = frame.duplicate(true); invalid.status = "stale"; check(not viewer.valid_frame(invalid), "stale cleared")
 invalid = frame.duplicate(true); invalid.validUntil = "2020-01-01T00:00:00Z"; check(not viewer.valid_frame(invalid), "expired")
 invalid = frame.duplicate(true); invalid.validUntil = Time.get_datetime_string_from_unix_time(now+60)+"Z"; check(not viewer.valid_frame(invalid), "lease cannot be renewed")
 invalid = frame.duplicate(true); invalid.position = null; check(not viewer.valid_frame(invalid), "unknown position")
 invalid = frame.duplicate(true); invalid.bounds.size.x = 18; check(not viewer.valid_frame(invalid), "fixed crop")
 invalid = frame.duplicate(true); invalid.bounds.origin.y = -80; check(not viewer.valid_frame(invalid), "unsupported height")
 invalid = frame.duplicate(true); invalid.unknownCells = 1; invalid.unknownIndices = [3757]; check(not viewer.valid_frame(invalid), "mask range")
 invalid = frame.duplicate(true); invalid.unknownCells = 2; invalid.unknownIndices = [0,0]; check(not viewer.valid_frame(invalid), "mask duplicates")
 var triangle = {"offset":[8,72,8],"positions":[0,-8,0,1,-8,0,0,-7,0],"normals":[0,0,1,0,0,1,0,0,1],"colors":[1,1,1,1,1,1,1,1,1],"uvs":[0,0,1,0,0,1],"indices":[0,1,2]}
 frame.sections = [triangle]; check(viewer.valid_frame(frame), "bounded indexed geometry")
 invalid = frame.duplicate(true); invalid.sections[0].positions[0] = INF; check(not viewer.valid_frame(invalid), "nonfinite vertex")
 invalid = frame.duplicate(true); invalid.sections[0].indices[0] = 99; check(not viewer.valid_frame(invalid), "index range")
 invalid = frame.duplicate(true); invalid.sections[0].positions = [0,0,0,1,0,0,0,1,0]; check(not viewer.valid_frame(invalid), "valid section offset with out-of-crop vertices")
 invalid = frame.duplicate(true); invalid.sections[0].offset[0] = 1608; check(not viewer.valid_frame(invalid), "distant section offset")
 invalid = frame.duplicate(true); invalid.sections[0].uvs.pop_back(); check(not viewer.valid_frame(invalid), "attribute lengths")
 viewer.free(); print(JSON.stringify({"checks":checks,"errors":errors,"network":false,"gameConnection":false})); quit(1 if errors else 0)
